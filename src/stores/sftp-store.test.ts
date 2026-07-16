import { describe, it, expect, beforeEach } from "vitest";
import { useSftpStore } from "./sftp-store";

beforeEach(() => {
  useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
});

describe("sftp-store openSession", () => {
  it("starts a session Connected and records the saved-host id", () => {
    useSftpStore.getState().openSession("sftp1", "ssh1", "prod", "root", false, "/srv", "host-1");

    const s = useSftpStore.getState().sessions.get("sftp1");
    expect(s?.status).toBe("Connected");
    expect(s?.statusMessage).toBeUndefined();
    expect(s?.hostId).toBe("host-1");
    expect(s?.sshSessionId).toBe("ssh1");
  });

  it("leaves hostId undefined for an ad-hoc session", () => {
    useSftpStore.getState().openSession("sftp1", "ssh1", "adhoc");
    expect(useSftpStore.getState().sessions.get("sftp1")?.hostId).toBeUndefined();
  });
});

describe("sftp-store setStatusBySsh", () => {
  it("updates every session riding on the matching SSH connection", () => {
    // Two explorer sessions can share one SSH link (e.g. a sudo swap leaves the
    // ssh id intact) — a status change must reach both.
    const { openSession, setStatusBySsh } = useSftpStore.getState();
    openSession("sftpA", "ssh1", "a");
    openSession("sftpB", "ssh1", "b");
    openSession("sftpC", "ssh2", "c");

    setStatusBySsh("ssh1", "Disconnected", "peer went away");

    const s = useSftpStore.getState().sessions;
    expect(s.get("sftpA")?.status).toBe("Disconnected");
    expect(s.get("sftpA")?.statusMessage).toBe("peer went away");
    expect(s.get("sftpB")?.status).toBe("Disconnected");
    // A session on a different SSH connection is untouched.
    expect(s.get("sftpC")?.status).toBe("Connected");
  });

  it("is a no-op (same state reference) when no session matches", () => {
    useSftpStore.getState().openSession("sftpA", "ssh1", "a");
    const before = useSftpStore.getState().sessions;

    useSftpStore.getState().setStatusBySsh("ssh-unknown", "Error", "boom");

    // Unrelated status events (other terminals) must not churn the map/re-render.
    expect(useSftpStore.getState().sessions).toBe(before);
  });

  it("clears back to Connected on a recovery event", () => {
    const { openSession, setStatusBySsh } = useSftpStore.getState();
    openSession("sftpA", "ssh1", "a");
    setStatusBySsh("ssh1", "Error", "dropped");
    setStatusBySsh("ssh1", "Connected");

    const s = useSftpStore.getState().sessions.get("sftpA");
    expect(s?.status).toBe("Connected");
    expect(s?.statusMessage).toBeUndefined();
  });
});
