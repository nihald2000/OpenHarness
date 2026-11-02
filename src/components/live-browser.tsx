"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Maximize2, Minimize2, MousePointer2, X } from "lucide-react";
import { mapFramePointToViewport } from "../../packages/core/src/sandbox/live-coordinates";
import { client } from "@/lib/client";

type DockState = "closed" | "docked" | "expanded";
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
  verifyLabel?: string;
  onDockWidthChange?: (width: number) => void;
};

type FrameMeta = { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
const MODIFIERS = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const pageIsHidden = () => document.visibilityState === "hidden";

export function LiveBrowser({
  sessionId, runId, previewUrl, state, setState, control = false, takeover, takeoverNote = "",
  onTakeoverNote, takeoverBusy = false, onTakeControl, onReturnControl, verifyLabel, onDockWidthChange,
}: Props) {
  const [status, setStatus] = useState("Disconnected");
  const [page, setPage] = useState({ title: "", url: "" });
  const [frameAge, setFrameAge] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [width, setWidth] = useState(() => {
    try { return Math.max(360, Math.min(1100, Number(localStorage.getItem("oh.dockWidth")) || window.innerWidth * 0.5)); }
    catch { return Math.max(360, Math.min(1100, window.innerWidth * 0.5)); }
  });
  const socket = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pending = useRef<{ data: string; meta: FrameMeta } | null>(null);
  const frameMeta = useRef<FrameMeta>({});
  const decoding = useRef(false);
  const lastFrameAt = useRef(0);
  const lastMouse = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const reconnectRef = useRef<(() => void) | null>(null);
  const owner = control ? "You have control" : "Agent is browsing";
  const expanded = state === "expanded";
  const isOpen = state !== "closed";
  const stateRef = useRef(state);
  stateRef.current = state;
  const dockIsClosed = () => stateRef.current === "closed";

  const drawLatest = useCallback(async () => {
    if (decoding.current) return;
    decoding.current = true;
    const next = pending.current;
    pending.current = null;
    try {
      const canvas = canvasRef.current;
      if (canvas && next) {
        const bytes = Uint8Array.from(atob(next.data), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        canvas.getContext("2d")?.drawImage(bmp, 0, 0);
        bmp.close();
        lastFrameAt.current = next.meta.timestamp ? next.meta.timestamp * 1000 : Date.now();
      }
    } catch {
      setStatus("Could not decode browser frame");
    } finally {
      decoding.current = false;
      if (pending.current) void drawLatest();
    }
  }, []);

  const connect = useCallback(async () => {
    if (!sessionId || dockIsClosed() || pageIsHidden()) return;
    setStatus("Connecting…");
    try {
      let ticketUrl = "";
      if (control) {
        const delays = [500, 500, 500, 500, 1_000, 1_500, 2_000, 3_000, 4_000];
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            ticketUrl = (await client.browser.liveTicket(sessionId, "control")).url;
            break;
          } catch (err) {
            if (Number((err as { status?: number }).status) !== 409 || attempt === 9) {
              if (Number((err as { status?: number }).status) === 409) setStatus("The agent hasn't paused yet");
              else throw err;
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 4_000));
          }
        }
      } else {
        ticketUrl = (await client.browser.liveTicket(sessionId, "view")).url;
      }
      if (!ticketUrl || dockIsClosed() || pageIsHidden()) return;
      const ws = new WebSocket(ticketUrl);
      socket.current = ws;
      ws.onopen = () => { retryCount.current = 0; setStatus("Live"); };
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
        } catch { /* Ignore malformed transient events. */ }
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (dockIsClosed() || pageIsHidden()) return;
        setStatus("Reconnecting…");
        const delay = Math.min(10_000, 1_000 * 2 ** retryCount.current++);
        retryTimer.current = setTimeout(() => void reconnectRef.current?.(), delay);
      };
      ws.onerror = () => setStatus("Reconnecting…");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not connect");
    }
  }, [sessionId, state, control, drawLatest]);
  reconnectRef.current = connect;

  useEffect(() => {
    if (!isOpen || !sessionId || document.visibilityState === "hidden") return;
    retryCount.current = 0;
    void connect();
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
    const ageTimer = setInterval(() => setFrameAge(lastFrameAt.current ? Date.now() - lastFrameAt.current : null), 500);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      clearInterval(ageTimer);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      const current = socket.current;
      socket.current = null;
      current?.close(1000, "Browser dock closed");
    };
  }, [isOpen, sessionId, state, control, connect]);

  useEffect(() => {
    if (state !== "expanded" || control) return;
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setState("docked"); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [state, control, setState]);

  useEffect(() => {
    try { localStorage.setItem("oh.dockWidth", String(width)); } catch { /* private mode */ }
  }, [width]);

  const send = (payload: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "input", payload }));
  };
  const resolveViewportPoint = (event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const meta = frameMeta.current;
    const frame = canvasRef.current;
    const targetW = meta?.deviceWidth && meta.deviceWidth > 0 ? meta.deviceWidth : frame?.width && frame.width > 0 ? frame.width : 1280;
    const targetH = meta?.deviceHeight && meta.deviceHeight > 0 ? meta.deviceHeight : frame?.height && frame.height > 0 ? frame.height : 800;
    return mapFramePointToViewport(event.clientX, event.clientY, rect, targetW, targetH);
  };
  const modifiers = (e: React.MouseEvent | React.KeyboardEvent) => MODIFIERS(e);
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const initial = width;
    const move = (e: PointerEvent) => {
      const next = Math.max(360, Math.min(1100, initial + startX - e.clientX));
      setWidth(next);
      onDockWidthChange?.(next);
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
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
      send({ kind: "mouse", type: "mousePressed", ...pt, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", buttons: e.buttons, clickCount: e.detail, modifiers: modifiers(e) });
    },
    onMouseUp: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!control) return;
      const pt = resolveViewportPoint(e);
      if (!pt) return;
      send({ kind: "mouse", type: "mouseReleased", ...pt, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", buttons: e.buttons, clickCount: e.detail, modifiers: modifiers(e) });
    },
    onWheel: (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!control) return;
      const pt = resolveViewportPoint(e);
      if (!pt) return;
      send({ kind: "wheel", ...pt, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) });
    },
    onContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => e.preventDefault(),
    onPaste: (e: React.ClipboardEvent<HTMLCanvasElement>) => { if (control) { e.preventDefault(); send({ kind: "text", text: e.clipboardData.getData("text") }); } },
    onKeyDown: (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (!control) return;
      const keyCode = e.keyCode;
      const special = new Set([8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 46]);
      if (special.has(keyCode)) e.preventDefault();
      const key = e.key === "Escape" ? "Escape" : e.key;
      const printable = Array.from(key).length === 1 && !/[\u0000-\u001f\u007f]/u.test(key);
      const text = key === "Enter" ? "\r" : printable ? key : undefined;
      send({ kind: "key", type: "keyDown", key, code: e.code, ...(text !== undefined ? { text } : {}), keyCode, modifiers: modifiers(e) });
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLCanvasElement>) => { if (control) send({ kind: "key", type: "keyUp", key: e.key === "Escape" ? "Escape" : e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e) }); },
  };

  const ageLabel = frameAge === null ? "waiting for frame" : frameAge < 1_000 ? "live" : `${(frameAge / 1_000).toFixed(1)} s behind`;
  const toolbar = (
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border bg-elev px-3 py-2 text-xs">
      <span className={`size-2 rounded-full ${status === "Live" ? "bg-success" : "bg-warning"}`} />
      <span className="text-muted">{ageLabel}</span>
      <span className="max-w-48 truncate font-medium text-fg" title={page.title}>{page.title || "Live browser"}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted" title={page.url}>{page.url}</span>
      <span className="rounded-full bg-subtle px-2 py-1 text-muted">{owner}</span>
      {verifyLabel && <span className="rounded-full bg-accent/10 px-2 py-1 text-accent">Verifying: {verifyLabel}</span>}
      {takeover && <span className="max-w-56 truncate text-accent" title={takeover.instructions || takeover.reason}>{takeover.instructions || takeover.reason}</span>}
      {control ? <>
        <input aria-label="Note for the agent" value={takeoverNote} onChange={(e) => onTakeoverNote?.(e.target.value)} placeholder="Note for the agent" className="w-36 rounded border border-border bg-bg px-2 py-1" />
        <button type="button" disabled={takeoverBusy} onClick={onReturnControl} className="rounded bg-accent px-2 py-1 font-medium text-accent-fg">{takeoverBusy ? "Returning…" : "Return control"}</button>
      </> : onTakeControl && <button type="button" disabled={takeoverBusy} onClick={onTakeControl} className="rounded border border-border px-2 py-1">{takeoverBusy ? "Requesting…" : "Take control"}</button>}
      {(previewUrl || page.url) && <button type="button" onClick={() => window.open(previewUrl || page.url, "_blank", "noopener,noreferrer")} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1">Open preview <ArrowUpRight size={13} /></button>}
      <button type="button" aria-label={expanded ? "Dock browser" : "Expand browser"} onClick={() => setState(expanded ? "docked" : "expanded")} className="rounded border border-border p-1.5">{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
      <button type="button" aria-label="Close browser" onClick={() => setState("closed")} className="rounded border border-border p-1.5"><X size={14} /></button>
    </div>
  );
  if (state === "closed") return null;
  const viewer = <>
    {toolbar}
    {control && !focused && <div className="border-b border-border px-3 py-1.5 text-center text-[11px] text-muted">Click the screen to type</div>}
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
      <canvas ref={canvasRef} aria-label="Live browser screen" tabIndex={0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} className={`max-h-full max-w-full object-contain outline-none ${control ? "cursor-crosshair" : ""}`} {...canvasEvents} />
      {control && !focused && <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/75"><span className="rounded bg-black/65 px-3 py-2"><MousePointer2 className="mr-2 inline size-4" />Click the screen to type</span></div>}
    </div>
  </>;
  return state === "docked" ? <>
    <div role="separator" aria-label="Resize browser dock" onPointerDown={onResizeStart} className="hidden w-1 cursor-col-resize bg-border hover:bg-accent lg:block" />
    <section aria-label="Browser dock" className="fixed inset-0 z-40 flex flex-col bg-bg lg:static lg:z-auto lg:min-w-[360px] lg:border-l lg:border-border lg:overflow-hidden" style={{ width }}>
      {viewer}
    </section>
  </> : <div className="fixed inset-0 z-50 bg-black/50 p-0 md:p-3" role="dialog" aria-label="Expanded live browser">
    <section className="mx-auto flex h-full w-full flex-col overflow-hidden bg-bg shadow-2xl md:rounded-xl md:border md:border-border">
      {viewer}
    </section>
  </div>;
}

export type BrowserDockState = DockState;
