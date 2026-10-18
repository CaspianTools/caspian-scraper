export type QuickAddItemKind = "project" | "source" | "destination" | "secret";

export interface QuickAddOpenArgs {
  kind?: QuickAddItemKind;
  projectId?: string;
}

export const ITEM_REQUIRES_PROJECT: Record<QuickAddItemKind, boolean> = {
  project: false,
  source: true,
  destination: true,
  secret: true,
};
