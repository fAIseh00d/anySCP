// Drives the dashboard's real "Delete Group & Hosts" flow. The cascade command
// purges each member host's keychain secret, so its failures matter: the
// handler had no `catch`, and is invoked as `void handleGroupDeleteConfirm(...)`
// — a rejection closed the dialog, skipped both reloads, told the user nothing,
// and surfaced as an unhandled promise rejection.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HostsDashboard } from "../HostsDashboard";
import { useToastStore } from "../../../stores/toast-store";
import type { HostGroup, SavedHost } from "../../../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const group: HostGroup = {
  id: "g1",
  name: "prod",
  color: "#6366f1",
  icon: null,
  sort_order: 0,
  default_username: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// A member host: the dialog only offers the cascade checkbox for a non-empty
// group, and its secret is what the cascade has to purge.
const member: SavedHost = {
  id: "h1",
  label: "web",
  host: "example.com",
  port: 22,
  username: "root",
  auth_type: "password",
  group_id: "g1",
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

/** Serve the dashboard's load-time commands; the cascade gets `cascade`. */
function mockBackend(cascade: () => Promise<unknown>) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "list_groups":
        return Promise.resolve([group]);
      case "list_hosts":
        return Promise.resolve([member]);
      case "list_recent_connections":
      case "s3_list_connections":
        return Promise.resolve([]);
      case "delete_group_with_hosts":
        return cascade();
      default:
        return Promise.resolve(undefined);
    }
  });
}

/** Render, then run the group card's Delete → cascade-checkbox → confirm flow. */
async function deleteGroupWithHosts() {
  render(<HostsDashboard />);
  const card = await screen.findByTestId("group-card-g1");
  fireEvent.contextMenu(card);
  fireEvent.click(screen.getByText("Delete Group"));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /delete group & hosts/i }));
}

const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

describe("HostsDashboard group delete", () => {
  beforeEach(() => {
    invoke.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("routes the cascade choice to delete_group_with_hosts and reloads", async () => {
    mockBackend(() => Promise.resolve(undefined));

    await deleteGroupWithHosts();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("delete_group_with_hosts", { id: "g1" }),
    );
    // Both lists are refetched so the deleted rows leave the screen.
    await waitFor(() => {
      const calls = invoke.mock.calls.filter(([cmd]) => cmd === "list_hosts");
      expect(calls.length).toBeGreaterThan(1);
    });
    expect(toastMessages()).toEqual([]);
  });

  it("reports a failed cascade instead of closing the dialog silently", async () => {
    mockBackend(() => Promise.reject(new Error("db locked")));

    await deleteGroupWithHosts();

    await waitFor(() => expect(toastMessages()).toEqual(['Couldn\'t delete "prod".']));
  });
});
