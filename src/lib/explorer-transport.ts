// Explorer transport dispatch.
//
// SFTP and SCP expose an identical command surface — same operation names,
// same argument shapes, same return types — differing only in the command
// prefix (`sftp_` vs `scp_`) and the session-id argument key (`sftpSessionId`
// vs `scpSessionId`). This module centralises that difference so the Explorer
// UI can stay transport-agnostic.
//
// SCP is used transparently as a fallback when a host has the SFTP subsystem
// disabled; the user never picks it explicitly (see exploreHost).

import { useSftpStore } from "../stores/sftp-store";

export type Transport = "sftp" | "scp";

/** The session-id argument key a transport's commands expect. */
function sessionKey(transport: Transport): "sftpSessionId" | "scpSessionId" {
  return transport === "scp" ? "scpSessionId" : "sftpSessionId";
}

/**
 * SftpError `kind`s that mean the connection is gone (not a per-file problem
 * like permission_denied / not_found). A failure with one of these means every
 * further op will fail too, so we surface the reconnect overlay immediately
 * rather than a red "operation failed" bar that lingers until keepalive fires.
 */
const CONNECTION_LOST_KINDS = new Set([
  "channel_error",
  "protocol_error",
  "ssh_session_not_found",
  "session_not_found",
]);

function isConnectionLost(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    CONNECTION_LOST_KINDS.has((err as { kind: string }).kind)
  );
}

/**
 * Invoke a transport command. `op` is the bare operation (e.g. "list_dir");
 * the prefix and session-id key are derived from `transport`. `extra` holds
 * the operation-specific arguments (path, oldPath, sourcePaths, …).
 */
export async function explorerInvoke<T>(
  transport: Transport,
  op: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(`${transport}_${op}`, {
      [sessionKey(transport)]: sessionId,
      ...extra,
    });
  } catch (err) {
    // A connection-level failure means the link is dead — trip the reconnect
    // overlay now (matching the terminal, which detects on its first failed
    // write) instead of leaving it to the ~90 s keepalive monitor. The error
    // still propagates so callers surface it as they did before.
    if (isConnectionLost(err)) {
      const message = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : undefined;
      useSftpStore.getState().markDisconnected(sessionId, message);
    }
    throw err;
  }
}
