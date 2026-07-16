export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  /** Position of divider, 0–1 */
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

/**
 * What a leaf pane holds. Today every pane in a tab is the same kind (terminal
 * tabs → terminal panes); this union is the seam that lets the shared layout
 * (split / zoom / resize / reconnect) host explorer panes too as the pane system
 * is unified. Keyed by `kind` so the renderer can dispatch per pane.
 */
export type PaneContent = { kind: "terminal"; sessionId: string };

export interface PaneNode {
  type: "pane";
  content: PaneContent;
}

export type LayoutNode = SplitNode | PaneNode;
