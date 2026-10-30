import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyEvent,
  type ConnectionStatus,
  type FixStatusEvent,
  type Message,
  type OpenHarnessEvent,
  type Session,
} from "@/types/sdk";
import { client } from "./client";
import { errorMessage, isStatus } from "./format";

export interface FixLoopState {
  phase: "verifying" | "fixing" | "succeeded" | "failed" | "stopped";
  iteration: number;
  maxIterations: number;
  reason?: string;
}

function deriveInitialFixState(
  session: Session | null,
  messages: Message[]
): FixLoopState | null {
  if (!session) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.info.role !== "user") continue;
    const verifyParts = msg.parts.filter((p) => p.type === "verify");
    if (verifyParts.length === 0) break;
    const lastVerify = verifyParts[verifyParts.length - 1];
    if (lastVerify && lastVerify.type === "verify") {
      if (session.status === "verifying") {
        return {
          phase: "verifying",
          iteration: lastVerify.iteration,
          maxIterations: lastVerify.maxIterations,
        };
      }
      if (session.status === "running" && !lastVerify.passed) {
        return {
          phase: "fixing",
          iteration: lastVerify.iteration,
          maxIterations: lastVerify.maxIterations,
        };
      }
    }
    break;
  }
  return null;
}

export function useSession(
  sessionId?: string,
  onEvent?: (event: OpenHarnessEvent) => void
) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(sessionId));
  const [notFound, setNotFound] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [fix, setFix] = useState<FixLoopState | null>(null);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const refreshSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [msgRes, sess] = await Promise.all([
        client.session.messages(sessionId),
        client.session.get(sessionId),
      ]);
      setMessages(msgRes.messages);
      setSession(sess);
      setFix((prev) => prev ?? deriveInitialFixState(sess, msgRes.messages));
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (isStatus(err, 404)) {
        setNotFound(true);
      } else {
        setError(errorMessage(err));
      }
    }
  }, [sessionId]);

  const resetFix = useCallback(() => {
    setFix(null);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      setLoading(false);
      setNotFound(false);
      setDeleted(false);
      setError(null);
      setFix(null);
      return;
    }

    let cancelled = false;
    let sub: { close: () => void } | null = null;
    const queue: OpenHarnessEvent[] = [];
    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      rafId = null;
      timeoutId = null;
      if (cancelled || queue.length === 0) return;
      const batch = queue.splice(0, queue.length);

      setSession((prev) => {
        let current = prev;
        for (const ev of batch) {
          if (ev.type === "session.updated" && ev.session.id === sessionId) {
            current = ev.session;
          } else if (ev.type === "run.status" && ev.sessionId === sessionId && current) {
            current = {
              ...current,
              status: ev.status,
              error: ev.error,
              updatedAt: Date.now(),
            };
          }
        }
        return current;
      });

      for (const ev of batch) {
        if (ev.type === "fix.status" && ev.sessionId === sessionId) {
          const fixEv = ev as FixStatusEvent;
          setFix({
            phase: fixEv.phase,
            iteration: fixEv.iteration,
            maxIterations: fixEv.maxIterations,
            reason: fixEv.reason,
          });
        } else if (ev.type === "session.deleted" && ev.sessionId === sessionId) {
          setDeleted(true);
        }
      }

      setMessages((prev) => {
        let next = prev;
        for (const ev of batch) {
          next = applyEvent(next, ev);
        }
        return next;
      });
    };

    const scheduleFlush = () => {
      if (rafId !== null || timeoutId !== null) return;
      if (typeof document !== "undefined" && document.hidden) {
        timeoutId = setTimeout(flush, 200);
      } else if (typeof requestAnimationFrame !== "undefined") {
        rafId = requestAnimationFrame(flush);
      } else {
        timeoutId = setTimeout(flush, 16);
      }
    };

    setLoading(true);
    setNotFound(false);
    setDeleted(false);
    setError(null);
    setFix(null);

    void (async () => {
      try {
        const msgRes = await client.session.messages(sessionId);
        if (cancelled) return;
        const sess = await client.session.get(sessionId);
        if (cancelled) return;

        setMessages(msgRes.messages);
        setSession(sess);
        setFix(deriveInitialFixState(sess, msgRes.messages));
        setLoading(false);

        sub = client.subscribe(
          sessionId,
          (ev) => {
            if (cancelled) return;
            onEventRef.current?.(ev);
            queue.push(ev);
            scheduleFlush();
          },
          (status) => {
            if (cancelled) return;
            setConnection(status);
          },
          (err) => {
            if (cancelled) return;
            if (isStatus(err, 404)) {
              setDeleted(true);
            }
          },
          { after: msgRes.lastSeq }
        );
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        if (isStatus(err, 404)) {
          setNotFound(true);
        } else {
          setError(errorMessage(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      sub?.close();
      if (rafId !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(rafId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [sessionId]);

  return {
    session,
    messages,
    loading,
    notFound,
    deleted,
    error,
    connection,
    fix,
    refreshSession,
    resetFix,
  };
}
