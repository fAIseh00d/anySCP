import { useCallback, useEffect, useRef, useState } from "react";

/**
 * WinSCP-style reconnect backoff: an immediate first attempt, then 2 / 4 / 8 /
 * 16 s. Once the schedule is exhausted, auto-retry stops and only a manual
 * Reconnect remains. The length of this array is the number of automatic tries.
 */
export const RECONNECT_DELAYS_MS = [0, 2000, 4000, 8000, 16000];

interface UseAutoReconnectOptions {
  /** Backoff schedule in ms; must be a stable reference (module const). */
  delaysMs?: number[];
  /** When false, no automatic attempts fire (e.g. nothing to re-dial). */
  enabled?: boolean;
}

export interface AutoReconnect {
  /** A reconnect attempt is in flight. */
  busy: boolean;
  /** Message from the last failed attempt, if any. */
  error: string | null;
  /** Number of failed attempts so far (0 = none yet). */
  attempt: number;
  /** True once the backoff schedule is exhausted — only manual retry remains. */
  autoStopped: boolean;
  /** Manual retry: clears the stop flag and re-dials immediately. */
  retry: () => void;
  /** Button label while busy, e.g. "Retrying (2/5)" or "Connecting". */
  busyLabel: string;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message);
  return "Reconnection failed";
}

/**
 * Drives a WinSCP-style auto-reconnect loop shared by the terminal and explorer
 * reconnect overlays, so both get identical retry behaviour from one state
 * machine. On mount it runs `reconnect()` immediately, then re-runs it on the
 * backoff schedule after each failure until the schedule is exhausted (after
 * which a manual Reconnect button remains).
 *
 * Contract for `reconnect`:
 * - MUST reject on failure — the loop advances the backoff on a thrown error.
 * - On success it should resolve; success is expected to unmount the host
 *   component (the connection status flips and the overlay stops rendering), so
 *   this hook deliberately does not track a "connected" state.
 */
export function useAutoReconnect(
  reconnect: () => Promise<void>,
  { delaysMs = RECONNECT_DELAYS_MS, enabled = true }: UseAutoReconnectOptions = {},
): AutoReconnect {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [autoStopped, setAutoStopped] = useState(false);
  // Guards a manual click racing an in-flight auto attempt.
  const busyRef = useRef(false);
  // Latest `reconnect` via a ref so a scheduled callback never runs a stale
  // closure, without making the scheduling effect depend on its identity.
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  const run = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await reconnectRef.current();
      // Success → the host component unmounts; leave state as-is.
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      setError(errMessage(err));
      setAttempt((a) => a + 1); // advance the backoff; the effect reschedules
    }
  }, []);

  // Schedule the next attempt. Each failure bumps `attempt`, which reschedules
  // with the next (longer) delay until the schedule runs out.
  useEffect(() => {
    if (!enabled || autoStopped || busy) return;
    if (attempt >= delaysMs.length) {
      setAutoStopped(true);
      return;
    }
    const timer = setTimeout(() => void run(), delaysMs[attempt]);
    return () => clearTimeout(timer);
  }, [enabled, attempt, autoStopped, busy, run, delaysMs]);

  const retry = useCallback(() => {
    setError(null);
    setAutoStopped(false);
    void run();
  }, [run]);

  const busyLabel =
    attempt > 0 && !autoStopped ? `Retrying (${attempt + 1}/${delaysMs.length})` : "Connecting";

  return { busy, error, attempt, autoStopped, retry, busyLabel };
}
