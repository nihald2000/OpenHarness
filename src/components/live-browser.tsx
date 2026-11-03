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

export type BrowserDockState = "closed" | "docked" | "expanded";
type DockState = BrowserDockState;
type ViewMode = "auto" | "interactive" | "stream";

type CursorState = {
  x: number;
  y: number;
  action?: string;
  label?: string;
  timestamp?: number;
};

type AgentActivity = {
  url?: string;
  title?: string;
  screenshotJpegBase64?: string;
  cursor?: CursorState;
  seq: number;
};

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
  agentActivity?: AgentActivity | null;
};

type FrameMeta = {
  timestamp?: number;
  deviceWidth?: number;
  deviceHeight?: number;
  cursor?: CursorState;
};

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
  agentActivity,
}: Props) {
  const [status, setStatus] = useState("Ready");
  const [page, setPage] = useState({ title: "", url: "" });
  const [polledPreviewUrl, setPolledPreviewUrl] = useState<string | null>(null);
  const [hasCanvasFrame, setHasCanvasFrame] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("auto");
  const [iframeKey, setIframeKey] = useState(0);
  const [focused, setFocused] = useState(false);
  const [aiCursor, setAiCursor] = useState<CursorState | null>(null);
  const [cursorVisible, setCursorVisible] = useState(false);
  const [width, setWidth] = useState(() => {
    try {
      return Math.max(400, Math.min(1100, Number(localStorage.getItem("oh.dockWidth")) || window.innerWidth * 0.48));
    } catch {
      return Math.max(400, Math.min(1100, window.innerWidth * 0.48));
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
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlight = useRef(false);
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

  // Stable mode selection: never auto-flip between iframe and canvas on timers or WebSocket status changes.
  // Default to Interactive Preview whenever a preview URL exists; user can switch to Agent View anytime.
  const showInteractiveIframe =
    viewMode === "interactive" || (viewMode === "auto" && Boolean(effectivePreviewUrl));

  const showInteractiveRef = useRef(showInteractiveIframe);
  showInteractiveRef.current = showInteractiveIframe;
  const effectivePreviewRef = useRef(effectivePreviewUrl);
  effectivePreviewRef.current = effectivePreviewUrl;

  const showCursorBriefly = useCallback((cursor: CursorState) => {
    setAiCursor({ ...cursor, timestamp: Date.now() });
    setCursorVisible(true);
    if (cursorFadeTimer.current) clearTimeout(cursorFadeTimer.current);
    cursorFadeTimer.current = setTimeout(() => {
      setCursorVisible(false);
    }, 1_600);
  }, []);

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
      // Keep previous frame
    } finally {
      decoding.current = false;
      if (pending.current) void drawLatest();
    }
  }, []);

  useEffect(() => {
    if (!agentActivity) return;
    if (agentActivity.url && agentActivity.url !== "about:blank") {
      setPage((prev) => ({
        title: agentActivity.title || prev.title || "Running App",
        url: agentActivity.url || prev.url,
      }));
    }
    if (agentActivity.cursor && typeof agentActivity.cursor.x === "number") {
      showCursorBriefly(agentActivity.cursor);
    }
    if (agentActivity.screenshotJpegBase64 && agentActivity.screenshotJpegBase64.length > 200) {
      const meta: FrameMeta = {
        timestamp: Date.now() / 1000,
        deviceWidth: 1280,
        deviceHeight: 800,
        cursor: agentActivity.cursor,
      };
      frameMeta.current = meta;
      pending.current = {
        data: agentActivity.screenshotJpegBase64,
        meta,
      };
      void drawLatest();
    }
  }, [agentActivity, drawLatest, showCursorBriefly]);

  // Stable poll function that does NOT depend on status or showInteractiveIframe
  const pollBrowserState = useCallback(async () => {
    if (!sessionId || dockIsClosed() || pageIsHidden() || pollInFlight.current) return;
    if (socket.current?.readyState === WebSocket.OPEN) return;
    pollInFlight.current = true;
    try {
      const useLite = showInteractiveRef.current && Boolean(effectivePreviewRef.current);
      const res = await client.browser.state(sessionId, { lite: useLite });
      if (res.url && res.url !== "about:blank") {
        setPage((prev) => (prev.url === res.url && prev.title === res.title ? prev : { title: res.title || "Running App", url: res.url }));
      }
      if (res.previewUrl) {
        setPolledPreviewUrl((prev) => (prev === res.previewUrl ? prev : res.previewUrl ?? null));
      }
      if (!useLite && res.screenshotJpegBase64 && res.screenshotJpegBase64.length > 200) {
        pending.current = {
          data: res.screenshotJpegBase64,
          meta: { timestamp: Date.now() / 1000, deviceWidth: 1280, deviceHeight: 800 },
        };
        void drawLatest();
        setStatus("Live");
      } else if (res.previewUrl || effectivePreviewRef.current) {
        setStatus("Live");
      }
    } catch {
      // Ignore transient poll errors
    } finally {
      pollInFlight.current = false;
    }
  }, [sessionId, drawLatest]);

  const connect = useCallback(async () => {
    if (!sessionId || dockIsClosed() || pageIsHidden()) return;
    if (socket.current && (socket.current.readyState === WebSocket.OPEN || socket.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      let ticketRes: { url: string; mode?: string } = { url: "" };
      if (control) {
        const delays = [300, 600];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          try {
            ticketRes = await client.browser.liveTicket(sessionId, "control");
            break;
          } catch (err) {
            if (Number((err as { status?: number }).status) !== 409 || attempt === delays.length - 1) {
              ticketRes = await client.browser.liveTicket(sessionId, "view").catch(() => ({ url: "", mode: "http-poll" }));
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 400));
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
            const meta = (data.metadata ?? {}) as FrameMeta;
            frameMeta.current = meta;
            pending.current = { data: data.data, meta };
            void drawLatest();
          } else if (data.type === "cursor" && typeof data.x === "number") {
            showCursorBriefly({
              x: Number(data.x),
              y: Number(data.y),
              action: typeof data.action === "string" ? data.action : undefined,
              label: typeof data.label === "string" ? data.label : undefined,
            });
          } else if (data.type === "page") {
            const nextUrl = String(data.url ?? "");
            const nextTitle = String(data.title ?? "");
            if (nextUrl && nextUrl !== "about:blank") {
              setPage((prev) => (prev.url === nextUrl && prev.title === nextTitle ? prev : { title: nextTitle, url: nextUrl }));
            }
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
        const delay = Math.min(10_000, 2_000 * 2 ** Math.min(3, retryCount.current++));
        retryTimer.current = setTimeout(() => void reconnectRef.current?.(), delay);
      };
      ws.onerror = () => {
        // Handled by onclose
      };
    } catch {
      await pollBrowserState();
    }
  }, [sessionId, control, drawLatest, pollBrowserState, showCursorBriefly]);
  reconnectRef.current = connect;

  useEffect(() => {
    if (!isOpen || !sessionId || document.visibilityState === "hidden") return;
    let disposed = false;
    retryCount.current = 0;
    void connect();
    void pollBrowserState();

    const scheduleNextPoll = () => {
      if (disposed) return;
      const intervalMs = showInteractiveRef.current && Boolean(effectivePreviewRef.current) ? 6_000 : 3_000;
      pollTimer.current = setTimeout(async () => {
        if (disposed) return;
        if (socket.current?.readyState !== WebSocket.OPEN) {
          await pollBrowserState();
        }
        scheduleNextPoll();
      }, intervalMs);
    };
    scheduleNextPoll();

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
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visible);
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      const current = socket.current;
      socket.current = null;
      current?.close(1000, "Browser dock closed");
    };
  }, [isOpen, sessionId, control, connect, pollBrowserState]);

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
      void client.browser
        .action(sessionId, "input", payload)
        .then(() => {
          void pollBrowserState();
        })
        .catch(() => {});
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
      const next = Math.max(400, Math.min(1100, initial + startX - e.clientX));
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

  const onMouse = (type: "mousePressed" | "mouseReleased" | "mouseMoved") => (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (type === "mouseMoved" && Date.now() - lastMouse.current < 32) return;
    lastMouse.current = Date.now();
    if (type === "mousePressed") {
      setFocused(true);
      e.currentTarget.focus();
    }
    const point = resolveViewportPoint(e);
    if (!point) return;
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    send({
      kind: "mouse",
      type,
      x: point.x,
      y: point.y,
      button: type === "mouseMoved" ? "none" : button,
      buttons: e.buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
      modifiers: modifiers(e),
    });
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const point = resolveViewportPoint(e);
    if (!point) return;
    send({
      kind: "wheel",
      x: point.x,
      y: point.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiers(e),
    });
  };

  const onKey = (type: "keyDown" | "keyUp") => (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!focused) return;
    e.preventDefault();
    const text = type === "keyDown" && e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined;
    send({
      kind: "key",
      type: text ? "keyDown" : type,
      key: e.key,
      code: e.code,
      text,
      keyCode: e.keyCode,
      modifiers: modifiers(e),
    });
  };

  const handleRefresh = () => {
    setIframeKey((k) => k + 1);
    void pollBrowserState();
  };

  if (!isOpen) return null;

  const isLiveReady = status === "Live" || Boolean(effectivePreviewUrl) || hasCanvasFrame;
  const displayUrl = effectivePreviewUrl || (page.url && page.url !== "about:blank" ? page.url : "");

  // Clean, single-row studio-grade browser header bar
  const toolbar = (
    <div className="border-b border-border bg-elev/95 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-2">
        {/* Left: Status + Segmented Mode Switcher */}
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            title={isLiveReady ? "Connected" : "Connecting"}
            className={`size-2 rounded-full ${
              isLiveReady ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
            }`}
          />
          <div className="flex items-center rounded-lg border border-border bg-bg p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("interactive")}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                showInteractiveIframe ? "bg-elev text-fg shadow-xs" : "text-muted hover:text-fg"
              }`}
              title="Interact directly with the live web app"
            >
              <MousePointer2 size={11} />
              <span>Preview</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode("stream");
                void pollBrowserState();
              }}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                !showInteractiveIframe ? "bg-elev text-fg shadow-xs" : "text-muted hover:text-fg"
              }`}
              title="Watch the agent's headless Playwright browser"
            >
              <MonitorPlay size={11} />
              <span>Agent View</span>
            </button>
          </div>
        </div>

        {/* Center: Compact Address Bar */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1">
          <Globe size={11} className="shrink-0 text-muted" />
          <span className="truncate font-mono text-[11px] text-fg/85">
            {displayUrl || "Waiting for dev server…"}
          </span>
          {verifyLabel && (
            <span className="ml-auto shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              {verifyLabel}
            </span>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleRefresh}
            title="Reload"
            className="rounded-lg border border-border bg-bg p-1.5 text-muted hover:bg-hover hover:text-fg"
          >
            <RefreshCw size={12} />
          </button>
          {effectivePreviewUrl && (
            <a
              href={effectivePreviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open preview in new tab"
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-bg px-2 py-1 text-[11px] font-medium text-fg hover:bg-hover"
            >
              <span className="hidden sm:inline">Open</span>
              <ArrowUpRight size={12} />
            </a>
          )}
          {!control && onTakeControl && (
            <button
              type="button"
              disabled={takeoverBusy}
              onClick={onTakeControl}
              className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-fg hover:bg-accent-strong disabled:opacity-60"
            >
              <Hand size={11} />
              <span>{takeoverBusy ? "Opening…" : "Take control"}</span>
            </button>
          )}
          <button
            type="button"
            aria-label={expanded ? "Dock browser" : "Expand browser"}
            onClick={() => setState(expanded ? "docked" : "expanded")}
            className="rounded-lg border border-border bg-bg p-1.5 text-muted hover:bg-hover hover:text-fg"
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            type="button"
            aria-label="Close browser"
            onClick={() => setState("closed")}
            className="rounded-lg border border-border bg-bg p-1.5 text-muted hover:bg-hover hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Takeover Banner (only shown when human control is active) */}
      {control && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5">
          <div className="min-w-0 flex-1 text-[11px]">
            <span className="font-semibold text-fg">
              {takeover?.reason || "You have browser control."}
            </span>
            {takeover?.instructions && (
              <span className="ml-1.5 text-muted">{takeover.instructions}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              aria-label="Note for the agent"
              value={takeoverNote}
              onChange={(e) => onTakeoverNote?.(e.target.value)}
              placeholder="Note for agent (optional)…"
              className="w-44 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
            />
            <VoiceMicButton compact onTranscript={onVoiceNote ?? (() => {})} disabled={takeoverBusy} />
            <button
              type="button"
              disabled={takeoverBusy}
              onClick={onReturnControl}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg hover:bg-accent-strong"
            >
              {takeoverBusy ? "Returning…" : "Return control"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const cursorLeftPct = aiCursor ? Math.max(3, Math.min(97, (aiCursor.x / 1280) * 100)) : 50;
  const cursorTopPct = aiCursor ? Math.max(3, Math.min(97, (aiCursor.y / 800) * 100)) : 50;

  // Keep both iframe and canvas mounted so switching tabs never reloads or flashes white
  const viewer = (
    <>
      {toolbar}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-neutral-950">
        {effectivePreviewUrl && (
          <iframe
            key={`${effectivePreviewUrl}:${iframeKey}`}
            title="Interactive App Preview"
            src={effectivePreviewUrl}
            className={`h-full w-full flex-1 border-0 bg-white ${
              showInteractiveIframe ? "block" : "hidden"
            }`}
            allow="clipboard-read; clipboard-write"
          />
        )}

        <div
          className={`relative min-h-0 flex-1 items-center justify-center ${
            showInteractiveIframe && effectivePreviewUrl ? "hidden" : "flex"
          }`}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label="Live browser viewport"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={onMouse("mousePressed")}
            onMouseUp={onMouse("mouseReleased")}
            onMouseMove={onMouse("mouseMoved")}
            onWheel={onWheel}
            onKeyDown={onKey("keyDown")}
            onKeyUp={onKey("keyUp")}
            className={`max-h-full max-w-full cursor-pointer object-contain outline-none ${
              focused ? "ring-1 ring-accent/60" : ""
            }`}
          />
          {aiCursor && hasCanvasFrame && (
            <div
              style={{ left: `${cursorLeftPct}%`, top: `${cursorTopPct}%` }}
              className={`pointer-events-none absolute z-20 -translate-x-0.5 -translate-y-0.5 transition-all duration-200 ease-out ${
                cursorVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              <MousePointer2
                size={18}
                className="fill-sky-500 text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]"
              />
              {aiCursor.label && (
                <span className="ml-3 mt-0.5 inline-block whitespace-nowrap rounded border border-sky-400/40 bg-slate-900/90 px-1.5 py-0.5 text-[10px] font-medium text-sky-100 shadow-md">
                  {aiCursor.label}
                </span>
              )}
            </div>
          )}
          {!hasCanvasFrame && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center">
              <div className="rounded-full border border-border bg-elev p-2.5 text-muted">
                <MonitorPlay size={20} />
              </div>
              <div className="max-w-xs space-y-1">
                <p className="text-xs font-medium text-fg">
                  {effectivePreviewUrl
                    ? "Preview server is running"
                    : "Waiting for preview server…"}
                </p>
                <p className="text-[11px] text-muted">
                  {effectivePreviewUrl
                    ? "Click Preview in the top bar to interact with the live app."
                    : "The live preview will appear automatically as soon as the app server starts."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );

  if (expanded) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Expanded live browser"
        className="fixed inset-0 z-50 flex flex-col bg-bg/95 p-3 backdrop-blur-xs"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-elev shadow-2xl">
          {viewer}
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        className="w-1 cursor-col-resize bg-border hover:bg-accent"
      />
      <aside
        style={{ width }}
        className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-elev"
      >
        {viewer}
      </aside>
    </>
  );
}
