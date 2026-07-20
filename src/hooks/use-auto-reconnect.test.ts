import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoReconnect } from "./use-auto-reconnect";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Fire scheduled timers and flush the async attempt. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useAutoReconnect", () => {
  it("runs immediately on mount and stops once reconnect succeeds", async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoReconnect(reconnect));

    await advance(0); // the immediate first attempt
    expect(reconnect).toHaveBeenCalledTimes(1);

    // Success ⇒ no further attempts (the host component would unmount).
    await advance(30000);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("retries on the WinSCP backoff (0/2/4/8/16 s), then stops after five", async () => {
    const reconnect = vi.fn().mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useAutoReconnect(reconnect));

    await advance(0);
    await advance(2000);
    await advance(4000);
    await advance(8000);
    await advance(16000);

    expect(reconnect).toHaveBeenCalledTimes(5);
    expect(result.current.autoStopped).toBe(true);

    await advance(60000);
    expect(reconnect).toHaveBeenCalledTimes(5); // exhausted — no more auto attempts
  });

  it("surfaces the failure message and advances the attempt counter", async () => {
    const reconnect = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useAutoReconnect(reconnect));

    await advance(0);
    expect(result.current.error).toBe("boom");
    expect(result.current.attempt).toBe(1);
    expect(result.current.busyLabel).toBe("Retrying (2/5)");
  });

  it("manual retry re-dials after the schedule is exhausted", async () => {
    const reconnect = vi.fn().mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useAutoReconnect(reconnect));

    // Exhaust all five (stepping lets each attempt's state settle).
    await advance(0);
    await advance(2000);
    await advance(4000);
    await advance(8000);
    await advance(16000);
    expect(result.current.autoStopped).toBe(true);
    const auto = reconnect.mock.calls.length;

    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reconnect.mock.calls.length).toBe(auto + 1);
  });

  it("does not auto-run when disabled", async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useAutoReconnect(reconnect, { enabled: false }));

    await advance(30000);
    expect(reconnect).not.toHaveBeenCalled();
  });
});
