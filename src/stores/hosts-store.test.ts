import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SavedHost } from "../types";
import { useHostsStore } from "./hosts-store";

// The store reaches the backend via a dynamic `import("@tauri-apps/api/core")`,
// so we mock that module's `invoke`. Each test swaps the implementation.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function makeHost(id: string, label: string): SavedHost {
  return {
    id,
    label,
    host: `${label}.example.com`,
    port: 22,
    username: "root",
    auth_type: "password",
    group_id: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
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
}

const a = makeHost("a", "alpha");
const b = makeHost("b", "bravo");
const c = makeHost("c", "charlie");

describe("hosts-store reorderHosts", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHostsStore.setState({ hosts: [a, b, c], error: null });
  });

  it("optimistically applies the new order and persists the id list", async () => {
    invoke.mockResolvedValue(undefined);
    const newOrder = [c, a, b];

    await useHostsStore.getState().reorderHosts(newOrder);

    expect(useHostsStore.getState().hosts).toEqual(newOrder);
    expect(invoke).toHaveBeenCalledWith("reorder_hosts", {
      orderedIds: ["c", "a", "b"],
    });
  });

  it("applies the new order immediately, before the backend resolves", async () => {
    let resolveInvoke: () => void = () => {};
    invoke.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const promise = useHostsStore.getState().reorderHosts([b, c, a]);

    // Optimistic update is visible synchronously, while invoke is still pending.
    expect(useHostsStore.getState().hosts.map((h) => h.id)).toEqual(["b", "c", "a"]);

    resolveInvoke();
    await promise;
  });

  it("reverts to the previous order and rethrows when persistence fails", async () => {
    invoke.mockRejectedValue(new Error("db locked"));

    await expect(
      useHostsStore.getState().reorderHosts([c, b, a]),
    ).rejects.toThrow("db locked");

    // Order rolled back to the pre-drag state.
    expect(useHostsStore.getState().hosts).toEqual([a, b, c]);
  });
});

describe("hosts-store duplicateHost", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHostsStore.setState({ hosts: [a, b, c], error: null });
  });

  /** Route every command this action issues; `duplicate_host` gets `outcome`. */
  function mockBackend(outcome: { id: string; credential_error: string | null }) {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_hosts") return Promise.resolve([a, b, c]);
      if (cmd === "duplicate_host") return Promise.resolve(outcome);
      throw new Error(`unexpected command: ${cmd}`);
    });
  }

  it("duplicates through the backend command, not a plain save_host", async () => {
    mockBackend({ id: "new", credential_error: null });

    await useHostsStore.getState().duplicateHost("a");

    // `save_host` would persist the row without copying the keychain secret —
    // exactly the bug that left duplicated password hosts unable to connect.
    expect(invoke).not.toHaveBeenCalledWith("save_host", expect.anything());
    expect(invoke).toHaveBeenCalledWith("duplicate_host", {
      host: expect.objectContaining({ label: "alpha (copy)", host: "alpha.example.com" }),
      sourceId: "a",
    });
  });

  it("gives the copy a fresh id and resets the source's connection stats", async () => {
    mockBackend({ id: "new", credential_error: null });

    await useHostsStore.getState().duplicateHost("a");

    const [, args] = invoke.mock.calls.find(([cmd]) => cmd === "duplicate_host")!;
    const copy = (args as { host: SavedHost }).host;
    expect(copy.id).not.toBe("a");
    expect(copy.last_connected_at).toBeNull();
    expect(copy.connection_count).toBeNull();
  });

  it("returns the credential-copy failure so the caller can surface it", async () => {
    mockBackend({ id: "new", credential_error: "Keychain error: user denied access" });

    const outcome = await useHostsStore.getState().duplicateHost("a");

    // Swallowing this is what let a credential-less copy look healthy until it
    // failed to authenticate with a misleading "server rejected credentials".
    expect(outcome.credential_error).toBe("Keychain error: user denied access");
  });

  it("keeps the copy visible when the post-duplicate reload fails", async () => {
    // Only the refetch failed here — the row and its keychain secret are
    // written. Letting that reject reported "couldn't duplicate" over a copy
    // that exists, dropped the outcome, and left no card on screen, so the user
    // duplicated again: a second row plus a second keychain entry.
    let duplicated = false;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_hosts") {
        return duplicated
          ? Promise.reject(new Error("db locked"))
          : Promise.resolve([a, b, c]);
      }
      if (cmd === "duplicate_host") {
        duplicated = true;
        return Promise.resolve({ id: "new", credential_error: null });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const outcome = await useHostsStore.getState().duplicateHost("a");

    expect(outcome.id).toBe("new");
    expect(useHostsStore.getState().hosts.map((h) => h.label)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "alpha (copy)",
    ]);
  });

  it("throws when the source host is gone", async () => {
    mockBackend({ id: "new", credential_error: null });

    await expect(useHostsStore.getState().duplicateHost("missing")).rejects.toThrow(
      /host not found/,
    );
  });
});
