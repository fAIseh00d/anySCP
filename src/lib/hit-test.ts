// Pointer hit-testing that sees THROUGH fixed overlays.
//
// `document.elementFromPoint` returns only the single topmost element, so any
// overlay covering the explorer (e.g. the transfer popover, which auto-opens on
// a transfer and sits at z-50 over the local pane) would defeat drag hit-testing
// — a cross-pane drop over that region resolves to the overlay, not the pane
// beneath, and the transfer/move silently no-ops. `elementsFromPoint` returns
// the full front-to-back stack, so we can skip overlays and find the first
// element matching `selector` (elements with `pointer-events: none`, like the
// drag ghost, are already excluded from the stack by the platform).
export function closestAtPoint(x: number, y: number, selector: string): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const hit = (el as HTMLElement).closest?.(selector);
    if (hit) return hit as HTMLElement;
  }
  return null;
}
