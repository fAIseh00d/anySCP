import { useCallback, useEffect, useRef, useState } from "react";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore } from "../../stores/tab-store";
import { ReconnectOverlay } from "../shared/ReconnectOverlay";
import type { Transport } from "../../lib/explorer-transport";

/**
 * WinSCP-style reconnect backoff: an immediate first attempt, then 2 / 4 / 8 /
 * 16 s. After the schedule is exhausted, auto-retry stops and a manual
 * Reconnect button remains.
 */
const RETRY_DELAYS_MS = [0, 2000, 4000, 8000, 16000];

interface ExplorerReconnectOverlayProps {
  /** The dead SFTP/SCP session's id — also the id of the tab that owns it. */
  sftpSessionId: string;
  tabId: string;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message);
  return "Reconnection failed";
}

/**
 * The explorer's equivalent of the terminal `DisconnectOverlay`: when the SFTP/
 * SCP session's SSH link drops, it re-dials the saved host (new SSH connection +
 * explorer channel), swapping the store session and tab id for the fresh ones.
 * Presentation is the shared `ReconnectOverlay`; the re-dial and backoff are
 * explorer-specific. Auto-retries on the WinSCP schedule, then waits for a click.
 */
export function ExplorerReconnectOverlay({ sftpSessionId, tabId }: ExplorerReconnectOverlayProps) {
  const session = useSftpStore((s) => s.sessions.get(sftpSessionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [autoStopped, setAutoStopped] = useState(false);
  // Guards against a manual click racing an in-flight auto-retry.
  const busyRef = useRef(false);

  const reconnect = useCallback(async () => {
    if (busyRef.current) return;
    const s = useSftpStore.getState().sessions.get(sftpSessionId);
    if (!s) return;
    if (!s.hostId) {
      // Ad-hoc session with no saved host — nothing to re-dial through.
      setError("No saved host to reconnect");
      setAutoStopped(true);
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sshSessionId = await invoke<string>("connect_saved_host_no_pty", { hostId: s.hostId });

      let newSftpId: string;
      let transport: Transport = "sftp";
      try {
        newSftpId = await invoke<string>("sftp_open", { sessionId: sshSessionId });
      } catch (sftpErr) {
        // SFTP subsystem unavailable — fall back to SCP, mirroring the initial dial.
        try {
          newSftpId = await invoke<string>("scp_open", { sessionId: sshSessionId });
          transport = "scp";
        } catch {
          void invoke("ssh_disconnect", { sessionId: sshSessionId });
          throw sftpErr;
        }
      }

      // Tear the dead session down so its bare handle + sftp wrapper don't leak
      // in the backend maps (best-effort — the peer is already gone).
      void invoke("sftp_close", { sftpSessionId }).catch(() => {});
      void invoke("ssh_disconnect", { sessionId: s.sshSessionId }).catch(() => {});

      // Swap in the fresh session + tab (both keyed by the new id). This tab —
      // and this overlay — unmount as AppShell re-renders on the new tab id.
      useSftpStore.getState().closeSession(sftpSessionId);
      useSftpStore.getState().openSession(newSftpId, sshSessionId, s.label, s.username, false, s.startDirectory, s.hostId);
      useTabStore.getState().removeTab(tabId);
      useTabStore.getState().addTab({ type: "sftp", id: newSftpId, label: s.label, transport, hostId: s.hostId });
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      setError(errMessage(err));
      // Advance the backoff; the effect below reschedules until the schedule runs out.
      setAttempt((a) => a + 1);
    }
  }, [sftpSessionId, tabId]);

  // Drive the auto-retry schedule. Each failed attempt bumps `attempt`, which
  // reschedules with the next (longer) delay until the schedule is exhausted.
  useEffect(() => {
    if (autoStopped || busy) return;
    if (attempt >= RETRY_DELAYS_MS.length) {
      setAutoStopped(true);
      return;
    }
    const timer = setTimeout(() => void reconnect(), RETRY_DELAYS_MS[attempt]);
    return () => clearTimeout(timer);
  }, [attempt, autoStopped, busy, reconnect]);

  const handleClose = useCallback(() => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_close", { sftpSessionId });
      } catch { /* already gone */ }
      useSftpStore.getState().closeSession(sftpSessionId);
      useTabStore.getState().removeTab(tabId);
    })();
  }, [sftpSessionId, tabId]);

  // Manual click: clear the stop flag and re-dial now.
  const handleReconnect = useCallback(() => {
    setError(null);
    setAutoStopped(false);
    void reconnect();
  }, [reconnect]);

  if (!session) return null;

  const status = session.status === "Error" ? "Error" : "Disconnected";
  const busyLabel =
    attempt > 0 && !autoStopped ? `Retrying (${attempt + 1}/${RETRY_DELAYS_MS.length})` : "Connecting";

  return (
    <ReconnectOverlay
      label={session.label}
      status={status}
      message={session.statusMessage}
      error={error}
      busy={busy}
      onReconnect={handleReconnect}
      onClose={handleClose}
      busyLabel={busyLabel}
    />
  );
}
