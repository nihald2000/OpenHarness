"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Globe,
  Hand,
  Maximize2,
  Minimize2,
  MonitorPlay,
  MousePointer2,
  RefreshCw,
  X,
} from "lucide-react";
import { mapFramePointToViewport } from "../../packages/core/src/sandbox/live-coordinates";
import { client } from "@/lib/client";
import { VoiceMicButton } from "./voice-mic-button";

type DockState = "closed" | "docked" | "expanded";
type ViewMode = "auto" | "interactive" | "stream";

type Props = {
  sessionId?: string;
  runId?: string;
  previewUrl?: string | null;
  state: DockState;
  setState: (state: DockState) => void;
  control?: boolean;
  takeover?: { reason: string; instructions?: string } | null;
  takeoverNote?: string;
  onTakeoverNote?: (note: string) => void;
  takeoverBusy?: boolean;
  onTakeControl?: () => void;
  onReturnControl?: () => void;
  onVoiceNote?: (text: string) => void;
  verifyLabel?: string;
  onDockWidthChange?: (width: number) => void;
};

type FrameMeta = { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
const MODIFIERS = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const pageIsHidden = () => document.visibilityState === "hidden";

export function LiveBrowser({
  sessionId,
  previewUrl,
  state,
  setState,
  control = false,
  takeover,
  takeoverNote = "",
  onTakeoverNote,
  takeoverBusy = false,
  onTakeControl,
  onReturnControl,
  onVoiceNote,
  verifyLabel,
  onDockWidthChange,
}: Props) {
  const [status, setStatus] = useState("Connecting…");
  const [page, setPage] = useState({ title: "", url: "" });
  const [polledPreviewUrl, setPolledPreviewUrl] = useState<string | null>(null);
  const [hasCanvasFrame, setHasCanvasFrame] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("auto");
  const [iframeKey, setIframeKey] = useState(0);
  const [frameAge, setFrameAge] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [width, setWidth] = useState(() => {
    try {
      return Math.max(380, Math.min(1100, Number(localStorage.getItem("oh.dockWidth")) || window.innerWidth * 0.5));
    } catch {
      return Math.max(380, Math.min(1100, window.innerWidth * 0.5));
    }
  });

  const socket = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pending = useRef<{ data: string; meta: FrameMeta } | null>(null);
  const frameMeta = useRef<FrameMeta>({});
  const decoding = useRef(false);
  const lastFrameAt = useRef(0);
  const lastMouse = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCount = useRef(0);
  const reconnectRef = useRef<(() => void) | null>(null);

  const expanded = state === "expanded";
  const isOpen = state !== "closed";
  const stateRef = useRef(state);
  stateRef.current = state;
  const dockIsClosed = () => stateRef.current === "closed";

  const normalizePreviewLink = useCallback((raw: string | null | undefined): string | null => {
    if (!raw) return null;
    try {
      const parsed = new URL(raw, window.location.origin);
      if (
        parsed.hostname.endsWith(".modal.run") &&
        parsed.hostname.includes("openharness-sandboxd-sandboxd") &&
        parsed.pathname.startsWith("/preview/")
      ) {
        return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      if (
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "0.0.0.0") &&
        parsed.port &&
        parsed.port !== "3000" &&
        parsed.port !== "4096" &&
        parsed.port !== "8080"
      ) {
        return `${window.location.origin}/preview/${parsed.port}${parsed.pathname === "/" ? "/" : parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      return parsed.href;
    } catch {
      if (raw.startsWith("/preview/")) return `${window.location.origin}${raw}`;
      return raw;
    }
  }, []);

  const effectivePreviewUrl =
    normalizePreviewLink(previewUrl) ||
    normalizePreviewLink(polledPreviewUrl) ||
    (page.url && page.url !== "about:blank" ? normalizePreviewLink(page.url) : null);

  // Determine whether to show interactive iframe or canvas stream
  const showInteractiveIframe =
    viewMode === "interactive" ||
    (viewMode === "auto" && Boolean(effectivePreviewUrl) && (!hasCanvasFrame || status !== "Live"));

  const drawLatest = useCallback(async () => {
    if (decoding.current) return;
    decoding.current = true;
    const next = pending.current;
    pending.current = null;
    try {
      const canvas = canvasRef.current;
      if (canvas && next) {
        let mime = "image/jpeg";
        const raw = next.data;
        if (raw.startsWith("iVBOR")) mime = "image/png";
        const binary = atob(raw);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        canvas.getContext("2d")?.drawImage(bmp, 0, 0);
        bmp.close();
        lastFrameAt.current = next.meta.timestamp ? next.meta.timestamp * 1000 : Date.now();
        setHasCanvasFrame(true);
      }
    } catch {
      // Keep previous frame or fallback to interactive preview
    } finally {
      decoding.current = false;
      if (pending.current) void drawLatest();
    }
  }, []);

  const pollBrowserState = useCallback(async () => {
    if (!sessionId || dockIsClosed() || pageIsHidden()) return;
    try {
      const res = await client.browser.state(sessionId);
      if (res.url && res.url !== "about:blank") {
        setPage({ title: res.title || "Running App", url: res.url });
      }
      if (res.previewUrl) {
        setPolledPreviewUrl(res.previewUrl);
      }
      if (res.screenshotJpegBase64 && res.screenshotJpegBase64.length > 200) {
        pending.current = {
          data: res.screenshotJpegBase64,
          meta: { timestamp: Date.now() / 1000, deviceWidth: 1280, deviceHeight: 800 },
        };
        void drawLatest();
        if (status !== "Live") setStatus("Live (Polled)");
      } else if (res.previewUrl || previewUrl) {
        if (status !== "Live") setStatus("Preview Ready");
      }
    } catch {
      // Ignore transient poll errors
    }
  }, [sessionId, drawLatest, previewUrl, status]);

  const connect = useCallback(async () => {
    if (!sessionId || dockIsClosed() || pageIsHidden()) return;
    setStatus("Connecting…");
    try {
      let ticketRes: { url: string; mode?: string } = { url: "" };
      if (control) {
        const delays = [400, 500, 600, 800, 1_000, 1_500];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          try {
            ticketRes = await client.browser.liveTicket(sessionId, "control");
            break;
          } catch (err) {
            if (Number((err as { status?: number }).status) !== 409 || attempt === delays.length - 1) {
              ticketRes = await client.browser.liveTicket(sessionId, "view").catch(() => ({ url: "", mode: "http-poll" }));
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 1_000));
          }
        }
      } else {
        ticketRes = await client.browser.liveTicket(sessionId, "view").catch(() => ({ url: "", mode: "http-poll" }));
      }
      if (dockIsClosed() || pageIsHidden()) return;

      if (!ticketRes.url || ticketRes.mode === "http-poll") {
        await pollBrowserState();
        return;
      }

      const ws = new WebSocket(ticketRes.url);
      socket.current = ws;
      ws.onopen = () => {
        retryCount.current = 0;
        setStatus("Live");
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (data.type === "frame" && typeof data.data === "string") {
            frameMeta.current = (data.metadata ?? {}) as FrameMeta;
            pending.current = { data: data.data, meta: frameMeta.current };
            void drawLatest();
          } else if (data.type === "page") {
            setPage({ title: String(data.title ?? ""), url: String(data.url ?? "") });
          } else if (data.type === "owner") {
            setStatus("Live");
          }
        } catch {
          // Ignore malformed transient events
        }
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (dockIsClosed() || pageIsHidden()) return;
        void pollBrowserState();
        const delay = Math.min(8_000, 1_500 * 2 ** Math.min(3, retryCount.current++));
        retryTimer.current = setTimeout(() => void reconnectRef.current?.(), delay);
      };
      ws.onerror = () => {
        void pollBrowserState();
      };
    } catch {
      await pollBrowserState();
    }
  }, [sessionId, control, drawLatest, pollBrowserState]);
  reconnectRef.current = connect;

  useEffect(() => {
    if (!isOpen || !sessionId || document.visibilityState === "hidden") return;
    retryCount.current = 0;
    void connect();
    void pollBrowserState();
    pollTimer.current = setInterval(() => {
      if (socket.current?.readyState !== WebSocket.OPEN) {
        void pollBrowserState();
      }
    }, 2_000);

    const visible = () => {
      if (document.visibilityState === "hidden") {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = null;
        socket.current?.close(1000, "Page hidden");
        socket.current = null;
      } else if (!dockIsClosed()) {
        retryCount.current = 0;
        void connect();
      }
    };
    document.addEventListener("visibilitychange", visible);
    const ageTimer = setInterval(
      () => setFrameAge(lastFrameAt.current ? Date.now() - lastFrameAt.current : null),
      500
    );
    return () => {
      document.removeEventListener("visibilitychange", visible);
      clearInterval(ageTimer);
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      const current = socket.current;
      socket.current = null;
      current?.close(1000, "Browser dock closed");
    };
  }, [isOpen, sessionId, state, control, connect, pollBrowserState]);

  useEffect(() => {
    if (state !== "expanded" || control) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setState("docked");
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [state, control, setState]);

  useEffect(() => {
    try {
      localStorage.setItem("oh.dockWidth", String(width));
    } catch {
      /* private mode */
    }
  }, [width]);

  const send = (payload: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: "input", payload }));
    } else if (sessionId) {
      void client.browser.action(sessionId, "input", payload).catch(() => {});
    }
  };

  const resolveViewportPoint = (event: {
    clientX: number;
    clientY: number;
    currentTarget: HTMLCanvasElement;
  }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const meta = frameMeta.current;
    const frame = canvasRef.current;
    const targetW =
      meta?.deviceWidth && meta.deviceWidth > 0
        ? meta.deviceWidth
        : frame?.width && frame.width > 0
          ? frame.width
          : 1280;
    const targetH =
      meta?.deviceHeight && meta.deviceHeight > 0
        ? meta.deviceHeight
        : frame?.height && frame.height > 0
          ? frame.height
          : 800;
    return mapFramePointToViewport(event.clientX, event.clientY, rect, targetW, targetH);
  };

  const modifiers = (e: React.MouseEvent | React.KeyboardEvent) => MODIFIERS(e);
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const initial = width;
    const move = (e: PointerEvent) => {
      const next = Math.max(380, Math.min(1100, initial + startX - e.clientX));
      setWidth(next);
      onDockWidthChange?.(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const canvasEvents = {
    onClick: (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.currentTarget.focus();
    },
    onMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!control) return;
      const now = performance.now();
      if (now - lastMouse.current < 33) return;
      lastMouse.current = now;
      const pt = resolveViewportPoint(e);
      if (!pt) return;
      send({ kind: "mouse", type: "mouseMoved", ...pt, buttons: e.buttons, modifiers: modifiers(e) });
    },
    onMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.currentTarget.focus();
      if (!control) return;
      const pt = resolveViewportPoint(e);
      if (!pt) return;
      send({
        kind: "mouse",
        type: "mousePressed",
        ...pt,
        button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
        buttons: e.buttons,
        clickCount: e.detail,
        modifiers: modifiers(e),
      });
    },
    onMouseUp: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!control) return;
      const pt = resolveViewportPoint(e);
      if (!pt) return;
      send({
        kind: "mouse",
        type: "mouseReleased",
        ...pt,
        button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
        buttons: e.buttons,
        clickCount: e.detail,
        modifiers: modifiers(e),
      });
    },
    onWheel: (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!control) return;
      const pt = resolveViewportPoint(e);
      if (!pt) return;
      send({ kind: "wheel", ...pt, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) });
    },
    onContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => e.preventDefault(),
    onPaste: (e: React.ClipboardEvent<HTMLCanvasElement>) => {
      if (control) {
        e.preventDefault();
        send({ kind: "text", text: e.clipboardData.getData("text") });
      }
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (!control) return;
      const keyCode = e.keyCode;
      const special = new Set([8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 46]);
      if (special.has(keyCode)) e.preventDefault();
      const key = e.key === "Escape" ? "Escape" : e.key;
      const printable = Array.from(key).length === 1 && !/[\u0000-\u001f\u007f]/u.test(key);
      const text = key === "Enter" ? "\r" : printable ? key : undefined;
      send({
        kind: "key",
        type: "keyDown",
        key,
        code: e.code,
        ...(text !== undefined ? { text } : {}),
        keyCode,
        modifiers: modifiers(e),
      });
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (control) {
        send({
          kind: "key",
          type: "keyUp",
          key: e.key === "Escape" ? "Escape" : e.key,
          code: e.code,
          keyCode: e.keyCode,
          modifiers: modifiers(e),
        });
      }
    },
  };

  if (state === "closed") return null;

  const isHealthy = status === "Live" || status === "Live (Polled)" || status === "Preview Ready" || Boolean(effectivePreviewUrl);
  const displayUrl = effectivePreviewUrl || page.url || "Waiting for app server or browser navigation…";
  const ageLabel =
    frameAge !== null && frameAge < 2_500
      ? "live"
      : showInteractiveIframe && effectivePreviewUrl
        ? "interactive"
        : status;

  const toolbar = (
    <div className="flex flex-col border-b border-border bg-elev text-xs">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`size-2.5 shrink-0 rounded-full ${isHealthy ? "bg-success" : "bg-warning animate-pulse"}`} />
          <span className="font-semibold text-fg truncate max-w-44" title={page.title || "Live Workspace Browser"}>
            {page.title || "Live Workspace Browser"}
          </span>
          <span className="rounded-md border border-border bg-bg px-2 py-0.5 text-[11px] text-muted">
            {control ? "You have control" : ageLabel}
          </span>
          {verifyLabel && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
              Verifying: {verifyLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-border bg-bg p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("interactive")}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                showInteractiveIframe ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
              }`}
              title="Interact directly with the live preview web server"
            >
              <Globe size={12} />
              <span>Interactive Preview</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("stream")}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                !showInteractiveIframe ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
              }`}
              title="Watch or control the agent Playwright browser stream"
            >
              <MonitorPlay size={12} />
              <span>Agent Browser</span>
            </button>
          </div>

          {!control && onTakeControl && (
            <button
              type="button"
              disabled={takeoverBusy}
              onClick={onTakeControl}
              className="inline-flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20"
            >
              <Hand size={12} />
              <span>{takeoverBusy ? "Requesting…" : "Take control"}</span>
            </button>
          )}

          <button
            type="button"
            aria-label={expanded ? "Dock browser" : "Expand browser"}
            onClick={() => setState(expanded ? "docked" : "expanded")}
            className="rounded-lg border border-border bg-bg p-1.5 text-muted hover:bg-hover hover:text-fg"
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            aria-label="Close browser"
            onClick={() => setState("closed")}
            className="rounded-lg border border-border bg-bg p-1.5 text-muted hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Address bar row */}
      <div className="flex items-center gap-2 border-t border-border/60 bg-bg/60 px-3 py-1.5">
        <button
          type="button"
          aria-label="Refresh preview"
          onClick={() => {
            setIframeKey((k) => k + 1);
            void pollBrowserState();
          }}
          className="rounded border border-border bg-elev p-1 text-muted hover:bg-hover hover:text-fg"
          title="Refresh preview"
        >
          <RefreshCw size={12} />
        </button>
        <div
          className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[11px] text-muted"
          title={displayUrl}
        >
          {displayUrl}
        </div>
        {effectivePreviewUrl && (
          <a
            href={effectivePreviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-fg hover:bg-accent-strong"
          >
            <span>Open in new tab</span>
            <ArrowUpRight size={12} />
          </a>
        )}
      </div>

      {/* Human Takeover Banner */}
      {(control || takeover) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-accent/30 bg-accent/10 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold text-accent">
              Browser Takeover Active — Inspect & Interact with the App
            </div>
            {takeover && (
              <div className="truncate text-[11px] text-fg" title={takeover.instructions || takeover.reason}>
                {takeover.instructions || takeover.reason}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              aria-label="Note for the agent"
              value={takeoverNote}
              onChange={(e) => onTakeoverNote?.(e.target.value)}
              placeholder="Feedback or instructions for agent…"
              className="w-52 rounded-lg border border-border bg-bg px-2.5 py-1 text-xs text-fg"
            />
            <VoiceMicButton compact onTranscript={onVoiceNote ?? (() => {})} disabled={takeoverBusy} />
            <button
              type="button"
              disabled={takeoverBusy}
              onClick={onReturnControl}
              className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-accent-fg hover:bg-accent-strong"
            >
              {takeoverBusy ? "Returning…" : "Return control to agent"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const viewer = (
    <>
      {toolbar}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-neutral-950">
        {showInteractiveIframe && effectivePreviewUrl ? (
          <iframe
            key={`${effectivePreviewUrl}:${iframeKey}`}
            title="Interactive App Preview"
            src={effectivePreviewUrl}
            className="h-full w-full flex-1 border-0 bg-white"
          />
        ) : (
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-950">
            <canvas
              ref={canvasRef}
              aria-label="Live browser screen"
              tabIndex={0}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              className={`max-h-full max-w-full object-contain outline-none ${
                control ? "cursor-crosshair" : ""
              } ${hasCanvasFrame ? "block" : "hidden"}`}
              {...canvasEvents}
            />
            {!hasCanvasFrame && (
              <div className="flex max-w-sm flex-col items-center justify-center gap-3 p-6 text-center">
                <Globe className="size-8 text-accent/80 animate-pulse" />
                <div className="text-sm font-medium text-white">
                  {effectivePreviewUrl
                    ? "Preview server is live"
                    : "Waiting for the agent to start the preview server or open a page…"}
                </div>
                <p className="text-xs text-neutral-400">
                  {effectivePreviewUrl
                    ? "Switch to Interactive Preview above or click below to interact with the live app directly."
                    : "As soon as the dev server starts or the browser navigates, the live preview will appear here automatically."}
                </p>
                {effectivePreviewUrl && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setViewMode("interactive")}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg"
                    >
                      Show Interactive Preview
                    </button>
                    <a
                      href={effectivePreviewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
                    >
                      <span>Open in new tab</span>
                      <ArrowUpRight size={13} />
                    </a>
                  </div>
                )}
              </div>
            )}
            {control && hasCanvasFrame && !focused && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/85">
                <span className="rounded-lg bg-black/75 px-3 py-2 shadow-lg">
                  <MousePointer2 className="mr-2 inline size-4" />
                  Click inside the browser to interact & type
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );

  return state === "docked" ? (
    <>
      <div
        role="separator"
        aria-label="Resize browser dock"
        onPointerDown={onResizeStart}
        className="hidden w-1 cursor-col-resize bg-border hover:bg-accent md:block"
      />
      <section
        aria-label="Browser dock"
        className="fixed inset-0 z-40 flex flex-col bg-bg md:static md:z-auto md:min-w-[360px] md:w-full md:border-l md:border-border md:overflow-hidden"
      >
        {viewer}
      </section>
    </>
  ) : (
    <div className="fixed inset-0 z-50 bg-black/60 p-0 md:p-4" role="dialog" aria-label="Expanded live browser">
      <section className="mx-auto flex h-full w-full flex-col overflow-hidden bg-bg shadow-2xl md:rounded-xl md:border md:border-border">
        {viewer}
      </section>
    </div>
  );
}

export type BrowserDockState = DockState;
