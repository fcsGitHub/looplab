// SSE event stream with cursor resume and event-id dedupe (A03).
// Reconnect: the browser EventSource retries automatically; we keep the last
// cursor and re-open with ?after=<cursor> so nothing is missed or duplicated.
import { useEffect, useRef, useState } from "react";
import type { PlatformEvent } from "./api";

export interface EventStreamState {
  events: PlatformEvent[];
  connected: boolean;
  /** true while the stream is re-syncing after a disconnect */
  resuming: boolean;
  lastError: string | null;
}

export function useEventStream(goalId: string | null): EventStreamState {
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const cursorRef = useRef<number | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setEvents([]);
    cursorRef.current = null;
    seenRef.current = new Set();
    if (!goalId) return;

    let closed = false;

    const open = () => {
      if (closed) return;
      const after = cursorRef.current;
      const url = `/v1/events?goal_id=${encodeURIComponent(goalId)}${after ? `&after=${after}` : ""}`;
      if (after) setResuming(true);
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;
      es.onopen = () => { setConnected(true); setResuming(false); setLastError(null); };
      es.addEventListener("platform", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as PlatformEvent;
          if (seenRef.current.has(data.event_id)) return; // dedupe by event_id
          seenRef.current.add(data.event_id);
          cursorRef.current = Math.max(cursorRef.current ?? 0, Number((ev as MessageEvent).lastEventId));
          setEvents((prev) => [...prev, data].slice(-2000));
        } catch { /* skip malformed */ }
      });
      es.onerror = () => {
        setConnected(false);
        setResuming(true);
        setLastError("连接中断，正在按游标续传…");
        es.close();
        setTimeout(open, 1500);
      };
    };
    open();

    return () => {
      closed = true;
      esRef.current?.close();
    };
  }, [goalId]);

  return { events, connected, resuming, lastError };
}
