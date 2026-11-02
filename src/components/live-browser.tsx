"use client";

import { useEffect, useRef, useState } from "react";
import { client } from "@/lib/client";

type Props = { sessionId?: string; control?: boolean; onTakeControl?: () => void };

export function LiveBrowser({ sessionId, control = false, onTakeControl }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const [frame, setFrame] = useState("");
  const [page, setPage] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const lastMouse = useRef(0);

  useEffect(() => {
    if (!open || !sessionId) return;
    let disposed = false;
    let ws: WebSocket | undefined;
    setStatus("Connecting…");
    const connect = async () => {
      const deadline = Date.now() + (control ? 60_000 : 0);
      let url = "";
      while (!disposed) {
        try { url = (await client.browser.liveTicket(sessionId, control ? "control" : "view")).url; break; }
        catch (err) {
          if (!control || Number((err as { status?: number }).status) !== 409 || Date.now() >= deadline) throw err;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (disposed || !url) return;
      if (disposed) return;
      ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => setStatus(control ? "Connected · control enabled" : "Connected · view only");
      ws.onclose = () => setStatus("Disconnected");
      ws.onerror = () => setStatus("Connection failed");
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as Record<string, any>;
          if (data.type === "frame" && typeof data.data === "string") setFrame(`data:image/jpeg;base64,${data.data}`);
          if (data.type === "page") setPage(`${data.title ?? ""} ${data.url ?? ""}`.trim());
        } catch { /* Ignore malformed transient events. */ }
      };
    };
    void connect().catch((err: unknown) => setStatus(err instanceof Error ? err.message : "Could not connect"));
    return () => {
      disposed = true;
      socket.current = null;
      ws?.close();
    };
  }, [open, sessionId, control]);

  const send = (payload: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "input", payload }));
  };
  const coords = (event: React.MouseEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * 1280 / rect.width, y: (event.clientY - rect.top) * 800 / rect.height };
  };

  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-hover" onClick={() => setOpen((v) => !v)} disabled={!sessionId}>
        {open ? "Stop watching" : "Watch live browser"}
      </button>
      {onTakeControl && <button type="button" className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg" onClick={onTakeControl}>Take control</button>}
      <span className="truncate text-[11px] text-muted" role="status">{status}</span>
    </div>
    {open && <div className="overflow-hidden rounded-lg border border-border bg-black">
      {page && <div className="truncate border-b border-white/20 px-2 py-1 text-[10px] text-white/75">{page}</div>}
      {frame ? <img
        src={frame}
        alt="Live browser screen"
        draggable={false}
        className={`block aspect-[16/10] w-full object-contain ${control ? "cursor-crosshair" : ""}`}
        onMouseMove={(e) => { if (!control) return; const now = performance.now(); if (now - lastMouse.current < 33) return; lastMouse.current = now; send({ kind: "mouse", type: "mouseMoved", ...coords(e), buttons: e.buttons }); }}
        onMouseDown={(e) => { if (control) send({ kind: "mouse", type: "mousePressed", ...coords(e), button: e.button === 2 ? "right" : "left", buttons: e.buttons, clickCount: 1 }); }}
        onMouseUp={(e) => { if (control) send({ kind: "mouse", type: "mouseReleased", ...coords(e), button: e.button === 2 ? "right" : "left", buttons: e.buttons }); }}
        onWheel={(e) => { if (control) send({ kind: "wheel", ...coords(e), deltaX: e.deltaX, deltaY: e.deltaY }); }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => { if (control) { e.preventDefault(); send({ kind: "key", type: "keyDown", key: e.key, code: e.code, text: e.key.length === 1 ? e.key : "" }); } }}
        onKeyUp={(e) => { if (control) send({ kind: "key", type: "keyUp", key: e.key, code: e.code }); }}
        tabIndex={control ? 0 : -1}
      /> : <div className="grid aspect-[16/10] place-items-center text-xs text-white/70">Waiting for browser frames…</div>}
    </div>}
  </div>;
}
