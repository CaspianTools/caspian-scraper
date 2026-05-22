"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { QuickAddDialog } from "./QuickAddDialog";
import type { QuickAddItemKind, QuickAddOpenArgs } from "./types";
import { ITEM_REQUIRES_PROJECT } from "./types";

export type QuickAddView = "list" | "picker" | "form";

interface QuickAddState {
  view: QuickAddView;
  kind: QuickAddItemKind | null;
  projectId: string | null;
}

interface QuickAddContextValue {
  open: (args?: QuickAddOpenArgs) => void;
  close: () => void;
  goToList: () => void;
  goToPicker: () => void;
  selectKind: (kind: QuickAddItemKind) => void;
  selectProject: (projectId: string) => void;
  state: QuickAddState;
  isOpen: boolean;
  /** Project id inferred from the URL (e.g. /projects/foo/sources). */
  activeProjectId: string | null;
}

const QuickAddContext = createContext<QuickAddContextValue | null>(null);

const RESERVED_PROJECT_SLUGS = new Set(["new"]);

function parseActiveProjectId(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/projects\/([^/]+)(?:\/.*)?$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (RESERVED_PROJECT_SLUGS.has(id)) return null;
  return id;
}

export function QuickAddProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const activeProjectId = useMemo(
    () => parseActiveProjectId(pathname),
    [pathname]
  );

  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<QuickAddState>({
    view: "list",
    kind: null,
    projectId: null,
  });

  const close = useCallback(() => {
    setIsOpen(false);
    setState({ view: "list", kind: null, projectId: null });
  }, []);

  const open = useCallback(
    (args?: QuickAddOpenArgs) => {
      const kind = args?.kind ?? null;
      const explicitProject = args?.projectId ?? null;

      if (!kind) {
        setState({ view: "list", kind: null, projectId: null });
        setIsOpen(true);
        return;
      }

      const requiresProject = ITEM_REQUIRES_PROJECT[kind];
      const resolvedProject =
        explicitProject ?? (requiresProject ? activeProjectId : null);

      if (requiresProject && !resolvedProject) {
        setState({ view: "picker", kind, projectId: null });
      } else {
        setState({ view: "form", kind, projectId: resolvedProject });
      }
      setIsOpen(true);
    },
    [activeProjectId]
  );

  const goToList = useCallback(() => {
    setState({ view: "list", kind: null, projectId: null });
  }, []);

  const goToPicker = useCallback(() => {
    setState((prev) => ({
      view: "picker",
      kind: prev.kind,
      projectId: null,
    }));
  }, []);

  const selectKind = useCallback(
    (kind: QuickAddItemKind) => {
      const requiresProject = ITEM_REQUIRES_PROJECT[kind];
      const resolvedProject = requiresProject ? activeProjectId : null;
      if (requiresProject && !resolvedProject) {
        setState({ view: "picker", kind, projectId: null });
      } else {
        setState({ view: "form", kind, projectId: resolvedProject });
      }
    },
    [activeProjectId]
  );

  const selectProject = useCallback((projectId: string) => {
    setState((prev) => ({
      view: "form",
      kind: prev.kind,
      projectId,
    }));
  }, []);

  const value = useMemo<QuickAddContextValue>(
    () => ({
      open,
      close,
      goToList,
      goToPicker,
      selectKind,
      selectProject,
      state,
      isOpen,
      activeProjectId,
    }),
    [open, close, goToList, goToPicker, selectKind, selectProject, state, isOpen, activeProjectId]
  );

  return (
    <QuickAddContext.Provider value={value}>
      {children}
      {isOpen && <QuickAddDialog />}
    </QuickAddContext.Provider>
  );
}

export function useQuickAdd(): QuickAddContextValue {
  const ctx = useContext(QuickAddContext);
  if (!ctx) {
    throw new Error("useQuickAdd must be used inside <QuickAddProvider>");
  }
  return ctx;
}
