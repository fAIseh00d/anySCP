// Drives the dashboard's real host Delete flow. `delete_host` returns NotFound
// once the row is already gone — a card left stale by a "Delete Group & Hosts"
// cascade earlier in the session — and propagates any other DB error. The
// handler had no `catch` and is invoked as `void handleDeleteHost(id)`, so a
// rejection closed the confirm dialog, left the card on screen, told the user
// nothing, and surfaced as an unhandled promise rejection.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HostsDashboard } from "../HostsDashboard";
import { useToastStore } from "../../../stores/toast-store";
import type { SavedHost } from "../../../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const host: SavedHost = {
  id: "h1",
  label: "web",
  host: "example.com",
  port: 22,
  username: "root",
  auth_type: "password",
  group_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  key_path: null,
  color: null,
  notes: null,
  environment: null,
  os_type: null,
  startup_command: null,
  proxy_jump: null,
  proxy_jump_host_id: null,
  start_directory: null,
  keep_alive_interval: null,
  default_shell: null,
  font_size: null,
  last_connected_at: null,
  connection_count: null,
};

/** Serve the dashboard's load-time commands; `delete_host` gets `del`. */
function mockBackend(del: () => Promise<unknown>) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "list_hosts":
        return Promise.resolve([host]);
      case "list_groups":
      case "list_recent_connections":
      case "s3_list_connections":
        return Promise.resolve([]);
      case "delete_host":
        return del();
      default:
        return Promise.resolve(undefined);
    }
  });
}

/** Render, then run the host card's Delete → confirm flow. */
async function deleteHost() {
  render(<HostsDashboard />);
  const card = await screen.findByTestId("host-card-h1");
  fireEvent.contextMenu(card);
  fireEvent.click(screen.getByText("Delete"));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
}

const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

describe("HostsDashboard delete", () => {
  beforeEach(() => {
    invoke.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("routes the Delete menu item through the backend delete_host command", async () => {
    mockBackend(() => Promise.resolve(undefined));

    await deleteHost();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_host", { id: "h1" }));
    expect(toastMessages()).toEqual([]);
  });

  it("reports a failed delete and reloads so a stale card can't linger", async () => {
    mockBackend(() => Promise.reject(new Error("host not found")));

    await deleteHost();

    await waitFor(() => expect(toastMessages()).toEqual(['Couldn\'t delete "web".']));
    // The refetch is the recovery for the already-deleted row: without it the
    // card stays on screen and the next click repeats the same failure.
    await waitFor(() => {
      const calls = invoke.mock.calls.filter(([cmd]) => cmd === "list_hosts");
      expect(calls.length).toBeGreaterThan(1);
    });
  });
});
