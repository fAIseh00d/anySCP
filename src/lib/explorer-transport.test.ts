import { describe, it, expect, vi, beforeEach } from "vitest";
import { explorerInvoke } from "./explorer-transport";
import { useSftpStore } from "../stores/sftp-store";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

beforeEach(() => {
  invoke.mockReset();
  useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
  useSftpStore.getState().openSession("sftp1", "ssh1", "prod");
});

describe("explorerInvoke transport dispatch", () => {
  it("prefixes the op and keys the session id by transport", async () => {
    invoke.mockResolvedValue([]);
    await explorerInvoke("sftp", "list_dir", "sftp1", { path: "/" });
    expect(invoke).toHaveBeenCalledWith("sftp_list_dir", { sftpSessionId: "sftp1", path: "/" });

    await explorerInvoke("scp", "list_dir", "scp1", { path: "/" });
    expect(invoke).toHaveBeenCalledWith("scp_list_dir", { scpSessionId: "scp1", path: "/" });
  });
});

describe("explorerInvoke connection-loss detection", () => {
  it("trips the reconnect overlay on a connection-level error and rethrows", async () => {
    invoke.mockRejectedValue({ kind: "channel_error", message: "broken pipe" });

    await expect(explorerInvoke("sftp", "list_dir", "sftp1", { path: "/" })).rejects.toMatchObject({
      kind: "channel_error",
    });

    expect(useSftpStore.getState().sessions.get("sftp1")).toMatchObject({
      status: "Disconnected",
      statusMessage: "broken pipe",
    });
  });

  it("leaves the session Connected on a per-file error (permission_denied)", async () => {
    invoke.mockRejectedValue({ kind: "permission_denied", message: "nope" });

    await expect(explorerInvoke("sftp", "delete", "sftp1", {})).rejects.toMatchObject({
      kind: "permission_denied",
    });

    expect(useSftpStore.getState().sessions.get("sftp1")?.status).toBe("Connected");
  });
});
