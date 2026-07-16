import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { ExplorerReconnectOverlay } from "./ExplorerReconnectOverlay";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore, pageTabId } from "../../stores/tab-store";

// The overlay reaches the backend via a dynamic `import("@tauri-apps/api/core")`.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

/** Seed a dropped SFTP session + its owning tab, then render the overlay. */
function setup(opts: { hostId?: string } = { hostId: "host-1" }) {
  useSftpStore.getState().openSession("sftp1", "ssh1", "prod", "root", false, "/srv", opts.hostId);
  useSftpStore.getState().setStatusBySsh("ssh1", "Disconnected", "peer went away");
  useTabStore.getState().addTab({ type: "sftp", id: "sftp1", label: "prod", transport: "sftp", hostId: opts.hostId });
  render(<ExplorerReconnectOverlay sftpSessionId="sftp1" tabId="sftp1" />);
}

/** Fire the pending backoff timer(s) and flush the async re-dial. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
  useTabStore.setState({
    tabs: new Map([[pageTabId("hosts"), { type: "page", id: pageTabId("hosts"), label: "Hosts", page: "hosts" }]]),
    tabOrder: [pageTabId("hosts")],
    activeTabId: pageTabId("hosts"),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ExplorerReconnectOverlay", () => {
  it("re-dials the saved host immediately and swaps in the fresh session + tab", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "connect_saved_host_no_pty") return Promise.resolve("ssh2");
      if (cmd === "sftp_open") return Promise.resolve("sftp2");
      return Promise.resolve(undefined);
    });
    setup();

    await advance(0); // the immediate (0 ms) first attempt

    expect(invoke).toHaveBeenCalledWith("connect_saved_host_no_pty", { hostId: "host-1" });
    expect(invoke).toHaveBeenCalledWith("sftp_open", { sessionId: "ssh2" });

    const sessions = useSftpStore.getState().sessions;
    expect(sessions.has("sftp1")).toBe(false);
    expect(sessions.get("sftp2")).toMatchObject({ sshSessionId: "ssh2", hostId: "host-1", status: "Connected" });

    const tabs = useTabStore.getState().tabs;
    expect(tabs.has("sftp1")).toBe(false);
    expect(tabs.get("sftp2")).toMatchObject({ type: "sftp", transport: "sftp" });

    // The dead session is torn down so it doesn't leak in the backend maps.
    expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp1" });
    expect(invoke).toHaveBeenCalledWith("ssh_disconnect", { sessionId: "ssh1" });
  });

  it("falls back to SCP when the SFTP subsystem is unavailable", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "connect_saved_host_no_pty") return Promise.resolve("ssh2");
      if (cmd === "sftp_open") return Promise.reject(new Error("no sftp"));
      if (cmd === "scp_open") return Promise.resolve("scp2");
      return Promise.resolve(undefined);
    });
    setup();

    await advance(0);

    expect(invoke).toHaveBeenCalledWith("scp_open", { sessionId: "ssh2" });
    expect(useTabStore.getState().tabs.get("scp2")).toMatchObject({ type: "sftp", transport: "scp" });
    expect(useSftpStore.getState().sessions.has("scp2")).toBe(true);
  });

  it("auto-retries on the WinSCP backoff, then stops after five attempts", async () => {
    invoke.mockRejectedValue(new Error("still down"));
    setup();

    // Schedule is 0 / 2 / 4 / 8 / 16 s → all five fire within 30 s.
    await advance(0);
    await advance(2000);
    await advance(4000);
    await advance(8000);
    await advance(16000);

    const dials = invoke.mock.calls.filter(([cmd]) => cmd === "connect_saved_host_no_pty");
    expect(dials).toHaveLength(5);

    // Backoff exhausted — advancing further must not schedule another attempt.
    await advance(60000);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "connect_saved_host_no_pty")).toHaveLength(5);
  });

  it("does not re-dial an ad-hoc session and surfaces why", async () => {
    setup({ hostId: undefined });

    await advance(0);

    expect(invoke).not.toHaveBeenCalledWith("connect_saved_host_no_pty", expect.anything());
    expect(screen.getByText("No saved host to reconnect")).toBeInTheDocument();
  });

  it("tears the dead session down and removes the tab on close", async () => {
    invoke.mockResolvedValue(undefined);
    setup();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close session"));
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp1" });
    expect(useSftpStore.getState().sessions.has("sftp1")).toBe(false);
    expect(useTabStore.getState().tabs.has("sftp1")).toBe(false);
  });
});
