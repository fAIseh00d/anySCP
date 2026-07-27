import { create } from "zustand";

/**
 * Transient highlight target for a CROSS-pane drag. The drag is driven entirely
 * by the source pane's component, but the drop target (a folder or the ".." row)
 * lives in the OTHER pane's component — which can't see the source's local drag
 * state. The source writes {paneKey, entryId} here as it hovers the sibling, and
 * the target pane highlights the matching row. Same-pane drag highlighting stays
 * local to the table (its own `dragOverId`); this is only for the cross-pane case.
 */
interface DragState {
  target: { paneKey: string; entryId: string } | null;
  setTarget: (t: { paneKey: string; entryId: string } | null) => void;
}

export const useDragStore = create<DragState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));
