import { useCallback } from "react";
import type { HostConfig, SessionId } from "../../types";
import { useSessionStore } from "../../stores/session-store";
import { useTabStore } from "../../stores/tab-store";
import { getTerminal } from "../../stores/terminal-instances";
import { useSettingsStore } from "../../stores/settings-store";
import { useAutoReconnect } from "../../hooks/use-auto-reconnect";
import { ReconnectOverlay } from "../shared/ReconnectOverlay";

interface DisconnectOverlayProps {
  sessionId: SessionId;
  /** The unified tab that owns this pane — needed to clean up the tab bar. */
  tabId: string;
  status: "Disconnected" | "Error";
  message?: string;
  hostConfig: HostConfig;
}

export function DisconnectOverlay({
  sessionId,
  tabId,
  status,
  message,
  hostConfig,
}: DisconnectOverlayProps) {
  // Recovery, not replacement: the backend re-dials the session's stored config
  // and swaps the transport under the SAME session id. The tab, pane, and xterm
  // buffer (scrollback) all survive; `ssh:status` Connecting → Connected on this
  // id hides the overlay. Must reject on failure so the auto-retry loop advances.
  const reconnect = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ssh_reconnect", { sessionId });

    // Mark the seam in the (preserved) scrollback, then bring the fresh 80×24
    // PTY up to the pane's real size.
    const entry = getTerminal(sessionId);
    if (entry) {
      entry.term.writeln("\r\n\x1b[2m— reconnected —\x1b[0m");
      await invoke("ssh_resize_pty", { sessionId, cols: entry.term.cols, rows: entry.term.rows });
    }
  }, [sessionId]);

  const autoReconnect = useSettingsStore((s) => s.autoReconnect);
  const auto = useAutoReconnect(reconnect, { enabled: autoReconnect });

  function handleClose() {
    void (async () => {
      // Tear down the (already dead) backend session so it doesn't linger in
      // the manager's session map — mirrors the tab X button and ⌘W.
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("ssh_disconnect", { sessionId });
      } catch { /* already disconnected */ }

      useSessionStore.getState().removeSession(sessionId);

      // removeSession only prunes the session-store's layout tree. If this was
      // the tab's last pane, the unified tab is now orphaned in the tab bar
      // with no working session, so remove it too. For a split, the tab still
      // owns the surviving pane and must stay. (issue #42)
      if (!useSessionStore.getState().tabs.get(tabId)) {
        useTabStore.getState().removeTab(tabId);
      }
    })();
  }

  return (
    <ReconnectOverlay
      label={`${hostConfig.username}@${hostConfig.host}`}
      status={status}
      message={message}
      error={auto.error}
      busy={auto.busy}
      onReconnect={auto.retry}
      onClose={handleClose}
      busyLabel={auto.busyLabel}
    />
  );
}
