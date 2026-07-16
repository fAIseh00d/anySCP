import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store";
import { useSftpStore } from "../stores/sftp-store";
import type { SshStatusPayload } from "../types";

/**
 * Global listener for `ssh:status` events emitted by the Rust backend.
 * Updates the session store (terminals) and the sftp store (explorers) so the
 * UI reflects connection state changes. The event is keyed on the SSH session
 * id: for a terminal that IS the session id; for an explorer it matches the
 * session's `sshSessionId`. Mount once in AppShell.
 */
export function useSshStatus(): void {
  const updateStatus = useSessionStore((s) => s.updateStatus);
  const setSftpStatusBySsh = useSftpStore((s) => s.setStatusBySsh);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;

      unlisten = await listen<SshStatusPayload>("ssh:status", (event) => {
        const { session_id, status } = event.payload;
        updateStatus(session_id, status.status, status.message);
        setSftpStatusBySsh(session_id, status.status, status.message);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [updateStatus, setSftpStatusBySsh]);
}
