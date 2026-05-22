"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuickAdd } from "./QuickAddProvider";
import { QuickAddItemList } from "./QuickAddItemList";
import { QuickAddProjectPicker } from "./QuickAddProjectPicker";
import { QuickAddProjectForm } from "./QuickAddProjectForm";
import { QuickAddSecretForm } from "./QuickAddSecretForm";
import { SourceForm } from "@/components/SourceForm";
import { DestinationForm } from "@/components/DestinationForm";
import { emptySourceFormInitial } from "@/components/sourceFormDefaults";
import { emptyDestinationFormInitial } from "@/components/destinationFormDefaults";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { useRouter } from "next/navigation";

const TITLES: Record<string, string> = {
  list: "Create new",
  picker: "Pick a project",
  "form:project": "New project",
  "form:source": "Add source",
  "form:destination": "Add destination",
  "form:secret": "Add secret",
};

export function QuickAddDialog() {
  const { state, close, goToList } = useQuickAdd();
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock body scroll while the dialog is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ESC closes the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Focus the panel on each view transition so screen readers + keyboard
  // users land somewhere sensible.
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>(
      "input, select, textarea, button, [tabindex]:not([tabindex='-1'])"
    );
    first?.focus();
  }, [state.view, state.kind]);

  if (!mounted) return null;

  const titleKey =
    state.view === "form" && state.kind
      ? `form:${state.kind}`
      : state.view;
  const title = TITLES[titleKey] ?? "Create new";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-10"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="fixed inset-0 bg-black/50 cursor-default"
      />
      <div
        ref={panelRef}
        className="relative w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xl"
      >
        <DialogHeader title={title} canGoBack={state.view !== "list"} onBack={goToList} onClose={close} />
        <div className="p-6">
          <DialogBody
            onAfterCreate={() => {
              close();
              router.refresh();
            }}
            onAfterCreateProject={(id: string) => {
              close();
              router.push(`/projects/${id}`);
              router.refresh();
            }}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}

function DialogHeader({
  title,
  canGoBack,
  onBack,
  onClose,
}: {
  title: string;
  canGoBack: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-6 h-14 border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-3 min-w-0">
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline shrink-0"
          >
            ← Back
          </button>
        )}
        <h2 className="text-base font-semibold tracking-tight truncate">
          {title}
        </h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="h-8 w-8 rounded-lg flex items-center justify-center text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
      >
        ×
      </button>
    </div>
  );
}

function DialogBody({
  onAfterCreate,
  onAfterCreateProject,
}: {
  onAfterCreate: () => void;
  onAfterCreateProject: (id: string) => void;
}) {
  const { state, close } = useQuickAdd();

  if (state.view === "list") {
    return <QuickAddItemList />;
  }
  if (state.view === "picker") {
    return <QuickAddProjectPicker />;
  }

  // view === "form"
  if (state.kind === "project") {
    return (
      <QuickAddProjectForm
        onSuccess={onAfterCreateProject}
        onCancel={close}
      />
    );
  }

  if (!state.projectId) {
    // Defensive: form view for a project-scoped kind without a project.
    // Shouldn't happen — provider routes through picker — but render a hint.
    return (
      <p className="text-sm text-zinc-500">No project selected. Go back.</p>
    );
  }

  if (state.kind === "source") {
    return (
      <SourceForm
        projectId={state.projectId}
        initial={emptySourceFormInitial()}
        onSuccess={onAfterCreate}
        onCancel={close}
      />
    );
  }

  if (state.kind === "destination") {
    return (
      <DialogDestinationForm
        projectId={state.projectId}
        onSuccess={onAfterCreate}
        onCancel={close}
      />
    );
  }

  if (state.kind === "secret") {
    return (
      <QuickAddSecretForm
        projectId={state.projectId}
        onSuccess={onAfterCreate}
        onCancel={close}
      />
    );
  }

  return null;
}

/**
 * DestinationForm needs `availableSecrets` to populate the secret-ref
 * dropdown. Fetch them client-side when opened via the popup.
 */
function DialogDestinationForm({
  projectId,
  onSuccess,
  onCancel,
}: {
  projectId: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [secrets, setSecrets] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/projects/${projectId}/secrets`);
        if (!res.ok) {
          setError(`Failed to load secrets (${res.status})`);
          return;
        }
        const body = (await res.json()) as { secrets?: { name: string }[] };
        if (cancelled) return;
        setSecrets((body.secrets ?? []).map((s) => s.name));
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }
  if (secrets === null) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }
  return (
    <DestinationForm
      projectId={projectId}
      initial={emptyDestinationFormInitial()}
      availableSecrets={secrets}
      onSuccess={onSuccess}
      onCancel={onCancel}
    />
  );
}
