import { create } from "zustand";
import { useSessionStore } from "./session-store";
import { useSftpStore } from "./sftp-store";
import { useS3Store } from "./s3-store";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PageId = "hosts" | "snippets" | "port-forwarding" | "history" | "settings";

export type UnifiedTab =
  // `hostId` is the saved-host id this session was dialed from — kept so the tab
  // can be re-dialed after a restart/crash (reconnect-on-focus). Ad-hoc sessions
  // (quick-connect, no saved host) have none and aren't restored. s3 needs none:
  // its tab id IS the persistent connection id.
  | { type: "terminal"; id: string; label: string; hostId?: string }
  | { type: "sftp"; id: string; label: string; transport?: "sftp" | "scp"; hostId?: string }
  | { type: "s3"; id: string; label: string }
  | { type: "page"; id: string; label: string; page: PageId };

export function getTabType(tab: UnifiedTab): string {
  return tab.type === "page" ? tab.page : tab.type;
}

// ─── Store ──────────────────────────────────────────────────────────────────

interface TabState {
  tabs: Map<string, UnifiedTab>;
  tabOrder: string[];
  activeTabId: string | null;

  addTab: (tab: UnifiedTab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabLabel: (id: string, label: string) => void;
  /** Swap a tab's ID in-place (used by SFTP sudo toggle when session reopens). */
  replaceTabId: (oldId: string, newId: string) => void;
  /** Activate or create a singleton page tab. */
  openPageTab: (page: PageId, label: string) => void;
  /** Find the most recent tab of a given type and activate it. Returns false if none found. */
  activateRecentTabOfType: (type: "terminal" | "sftp" | "s3") => boolean;
}

const PAGE_TAB_PREFIX = "page:";

export function pageTabId(page: PageId): string {
  return `${PAGE_TAB_PREFIX}${page}`;
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: new Map<string, UnifiedTab>([
    [pageTabId("hosts"), { type: "page", id: pageTabId("hosts"), label: "Hosts", page: "hosts" }],
  ]),
  tabOrder: [pageTabId("hosts")],
  activeTabId: pageTabId("hosts"),

  addTab: (tab) =>
    set((state) => {
      const tabs = new Map(state.tabs);
      tabs.set(tab.id, tab);
      const tabOrder = state.tabOrder.includes(tab.id)
        ? state.tabOrder
        : [...state.tabOrder, tab.id];
      return { tabs, tabOrder, activeTabId: tab.id };
    }),

  removeTab: (id) =>
    set((state) => {
      const tabs = new Map(state.tabs);
      tabs.delete(id);
      const tabOrder = state.tabOrder.filter((t) => t !== id);

      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        // Activate the previous tab, or the next, or hosts fallback
        const oldIdx = state.tabOrder.indexOf(id);
        activeTabId =
          tabOrder[Math.min(oldIdx, tabOrder.length - 1)] ??
          pageTabId("hosts");

        // Ensure hosts tab exists as fallback
        if (!tabs.has(activeTabId)) {
          const hostsId = pageTabId("hosts");
          const hostsTab: UnifiedTab = { type: "page", id: hostsId, label: "Hosts", page: "hosts" };
          tabs.set(hostsId, hostsTab);
          if (!tabOrder.includes(hostsId)) tabOrder.push(hostsId);
          activeTabId = hostsId;
        }

        // Sync domain stores
        syncDomainStores(tabs.get(activeTabId)!);
      }

      return { tabs, tabOrder, activeTabId };
    }),

  setActiveTab: (id) =>
    set((state) => {
      const tab = state.tabs.get(id);
      if (!tab) return state;
      syncDomainStores(tab);
      return { activeTabId: id };
    }),

  updateTabLabel: (id, label) =>
    set((state) => {
      const tab = state.tabs.get(id);
      if (!tab) return state;
      const tabs = new Map(state.tabs);
      tabs.set(id, { ...tab, label });
      return { tabs };
    }),

  replaceTabId: (oldId, newId) =>
    set((state) => {
      const tab = state.tabs.get(oldId);
      if (!tab) return state;
      const tabs = new Map(state.tabs);
      tabs.delete(oldId);
      tabs.set(newId, { ...tab, id: newId });
      const tabOrder = state.tabOrder.map((t) => (t === oldId ? newId : t));
      const activeTabId = state.activeTabId === oldId ? newId : state.activeTabId;
      return { tabs, tabOrder, activeTabId };
    }),

  openPageTab: (page, label) => {
    const id = pageTabId(page);
    const state = get();
    if (state.tabs.has(id)) {
      get().setActiveTab(id);
    } else {
      get().addTab({ type: "page", id, label, page });
    }
  },

  activateRecentTabOfType: (type) => {
    const state = get();
    // Walk tabOrder in reverse to find the most recent tab of this type
    for (let i = state.tabOrder.length - 1; i >= 0; i--) {
      const tab = state.tabs.get(state.tabOrder[i]);
      if (tab && tab.type === type) {
        get().setActiveTab(tab.id);
        return true;
      }
    }
    return false;
  },
}));

// ─── Persistence ──────────────────────────────────────────────────────────────
// The open-tab list is written to app_settings on every change and rehydrated on
// launch, so tabs survive a restart/crash. Only saved-host-backed connection
// tabs can be re-dialed (reconnect-on-focus), so ad-hoc sessions and their
// transient ids are omitted; s3 persists by its stable connection id.

/** Serialized form of a restorable tab (a discriminated subset of UnifiedTab). */
export interface PersistedTab {
  kind: UnifiedTab["type"];
  id: string;
  label: string;
  page?: PageId;
  transport?: "sftp" | "scp";
  hostId?: string;
}

export interface PersistedTabs {
  activeTabId: string | null;
  tabs: PersistedTab[];
}

export const OPEN_TABS_KEY = "open_tabs";

function serializeTabs(state: TabState): PersistedTabs {
  const tabs: PersistedTab[] = [];
  for (const id of state.tabOrder) {
    const t = state.tabs.get(id);
    if (!t) continue;
    if (t.type === "page") tabs.push({ kind: "page", id: t.id, label: t.label, page: t.page });
    else if (t.type === "s3") tabs.push({ kind: "s3", id: t.id, label: t.label });
    else if (t.type === "sftp" && t.hostId)
      tabs.push({ kind: "sftp", id: t.id, label: t.label, transport: t.transport, hostId: t.hostId });
    else if (t.type === "terminal" && t.hostId)
      tabs.push({ kind: "terminal", id: t.id, label: t.label, hostId: t.hostId });
  }
  return { activeTabId: state.activeTabId, tabs };
}

// Debounced so a burst of changes (e.g. opening several tabs) writes once.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const value = JSON.stringify(serializeTabs(useTabStore.getState()));
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_setting", { key: OPEN_TABS_KEY, value });
      } catch { /* best-effort */ }
    })();
  }, 150);
}

useTabStore.subscribe(schedulePersist);

// ─── Domain store sync ──────────────────────────────────────────────────────

function syncDomainStores(tab: UnifiedTab) {
  if (tab.type === "terminal") {
    useSessionStore.getState().focusTab(tab.id);
  } else if (tab.type === "sftp") {
    useSftpStore.getState().setActiveSftpSession(tab.id);
  } else if (tab.type === "s3") {
    useS3Store.getState().setActiveS3Session(tab.id);
  }
}
