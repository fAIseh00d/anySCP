import { useCallback } from "react";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore } from "../../stores/tab-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useAutoReconnect } from "../../hooks/use-auto-reconnect";
import { ReconnectOverlay } from "../shared/ReconnectOverlay";
import type { Transport } from "../../lib/explorer-transport";

interface ExplorerReconnectOverlayProps {
  /** The dead SFTP/SCP session's id — also the id of the tab that owns it. */
  sftpSessionId: string;
  tabId: string;
}

/**
 * The explorer's equivalent of the terminal `DisconnectOverlay`: when the SFTP/
 * SCP session's SSH link drops, it re-dials the saved host (new SSH connection +
 * explorer channel), swapping the store session and tab id for the fresh ones.
 * Presentation is the shared `ReconnectOverlay`; the backoff/retry state machine
 * is the shared `useAutoReconnect`; only the re-dial + swap is explorer-specific.
 */
export function ExplorerReconnectOverlay({ sftpSessionId, tabId }: ExplorerReconnectOverlayProps) {
  const session = useSftpStore((s) => s.sessions.get(sftpSessionId));
  // Ad-hoc sessions have no saved host to re-dial through — disable auto-retry
  // and surface why instead of pointlessly cycling the backoff.
  const canReconnect = !!session?.hostId;

  const reconnect = useCallback(async () => {
    const s = useSftpStore.getState().sessions.get(sftpSessionId);
    if (!s?.hostId) throw new Error("No saved host to reconnect");

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

    // Tear the dead session down so its bare handle + sftp wrapper don't leak in
    // the backend maps (best-effort — the peer is already gone).
    void invoke("sftp_close", { sftpSessionId }).catch(() => {});
    void invoke("ssh_disconnect", { sessionId: s.sshSessionId }).catch(() => {});

    // Swap in the fresh session + tab (both keyed by the new id). This tab — and
    // this overlay — unmount as AppShell re-renders on the new tab id.
    useSftpStore.getState().closeSession(sftpSessionId);
    useSftpStore.getState().openSession(newSftpId, sshSessionId, s.label, s.username, false, s.startDirectory, s.hostId);
    useTabStore.getState().removeTab(tabId);
    useTabStore.getState().addTab({ type: "sftp", id: newSftpId, label: s.label, transport, hostId: s.hostId });
  }, [sftpSessionId, tabId]);

  const autoReconnect = useSettingsStore((s) => s.autoReconnect);
  const auto = useAutoReconnect(reconnect, { enabled: canReconnect && autoReconnect });

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

  if (!session) return null;

  const status = session.status === "Error" ? "Error" : "Disconnected";
  const error = canReconnect ? auto.error : "No saved host to reconnect";

  return (
    <ReconnectOverlay
      label={session.label}
      status={status}
      message={session.statusMessage}
      error={error}
      busy={auto.busy}
      onReconnect={auto.retry}
      onClose={handleClose}
      busyLabel={auto.busyLabel}
    />
  );
}
