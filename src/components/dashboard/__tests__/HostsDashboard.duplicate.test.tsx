// Drives the dashboard's real "Duplicate" menu item all the way to the Tauri
// command. This is the tier that catches the original bug: the store had a
// correct `duplicateHost`, but the dashboard handler reimplemented duplication
// inline with `save_host` and bypassed it — so a store-level test passed while
// the button stayed broken. It also covers the failure paths the handler used
// to swallow, which left a click with no visible result.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HostsDashboard } from "../HostsDashboard";
import { useToastStore } from "../../../stores/toast-store";
import type { SavedHost } from "../../../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function makeHost(over: Partial<SavedHost> = {}): SavedHost {
  return {
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
    ...over,
  };
}

/** Serve the dashboard's load-time commands; `duplicate_host` gets `duplicate`. */
function mockBackend(duplicate: () => Promise<unknown>) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "list_hosts":
        return Promise.resolve([makeHost()]);
      case "list_groups":
      case "list_recent_connections":
      case "s3_list_connections":
        return Promise.resolve([]);
      case "duplicate_host":
        return duplicate();
      default:
        return Promise.resolve(undefined);
    }
  });
}

/** Render, wait for the seeded host, then right-click it and hit Duplicate. */
async function clickDuplicate() {
  render(<HostsDashboard />);
  const card = await screen.findByTestId("host-card-h1");
  fireEvent.contextMenu(card);
  fireEvent.click(screen.getByText("Duplicate"));
}

const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

describe("HostsDashboard duplicate", () => {
  beforeEach(() => {
    invoke.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("routes the Duplicate menu item through the backend duplicate_host command", async () => {
    mockBackend(() => Promise.resolve({ id: "h2", credential_error: null }));

    await clickDuplicate();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("duplicate_host", {
        host: expect.objectContaining({ label: "web (copy)" }),
        sourceId: "h1",
      }),
    );
    // `save_host` is the bypass that skipped the keychain copy.
    expect(invoke).not.toHaveBeenCalledWith("save_host", expect.anything());
    expect(toastMessages()).toEqual([]);
  });

  it("warns when the copy was created but its credential didn't come across", async () => {
    mockBackend(() =>
      Promise.resolve({ id: "h2", credential_error: "Keychain error: user denied access" }),
    );

    await clickDuplicate();

    await waitFor(() =>
      expect(toastMessages()).toEqual([
        'Duplicated "web", but its saved credential didn\'t copy — re-enter it on the copy.',
      ]),
    );
  });

  it("reports a failed duplicate instead of leaving the click silent", async () => {
    mockBackend(() => Promise.reject(new Error("db locked")));

    await clickDuplicate();

    await waitFor(() => expect(toastMessages()).toEqual(['Couldn\'t duplicate "web".']));
  });
});
