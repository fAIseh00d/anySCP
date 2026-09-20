// Guards the group-delete dialog's wiring: the "Delete Group & Hosts" choice
// must confirm with deleteHosts=true, which is what routes the dashboard to the
// backend `delete_group_with_hosts` command (that purges each host's keychain
// secret). Confirming without the checkbox keeps the hosts, so it must pass
// false — otherwise a plain group delete would cascade and orphan credentials.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GroupDeleteDialog } from "./GroupDeleteDialog";
import type { HostGroup } from "../../types";

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

describe("GroupDeleteDialog", () => {
  it("confirms with deleteHosts=true only when the cascade box is checked", () => {
    const onConfirm = vi.fn();
    render(<GroupDeleteDialog group={group} hostCount={2} onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /delete group & hosts/i }));

    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("confirms with deleteHosts=false when the box is left unchecked (hosts kept)", () => {
    const onConfirm = vi.fn();
    render(<GroupDeleteDialog group={group} hostCount={2} onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^delete group$/i }));

    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});
