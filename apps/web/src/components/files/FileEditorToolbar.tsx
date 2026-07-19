import { LoaderCircle, Redo2, Save, Undo2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import type { FileSavePhase } from "./fileSaveCoordinator";

const SAVED_INDICATOR_DURATION_MS = 1_500;

export interface FileEditorToolbarProps {
  readonly savePhase: FileSavePhase;
  readonly confirmedRevision: number;
  readonly canSave: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly cleanStatus: string | null;
  readonly onSave: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

function ToolbarAction({
  label,
  tooltip,
  disabled,
  className,
  onClick,
  children,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly disabled: boolean;
  readonly className?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={className}
            disabled={disabled}
            size="icon-xs"
            variant="ghost"
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function FileEditorToolbar({
  savePhase,
  confirmedRevision,
  canSave,
  canUndo,
  canRedo,
  cleanStatus,
  onSave,
  onUndo,
  onRedo,
}: FileEditorToolbarProps) {
  const lastConfirmedRevisionRef = useRef(confirmedRevision);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    const clearSavedTimeout = () => {
      if (savedTimeoutRef.current !== null) {
        clearTimeout(savedTimeoutRef.current);
        savedTimeoutRef.current = null;
      }
    };

    const revisionIncreased = confirmedRevision > lastConfirmedRevisionRef.current;
    lastConfirmedRevisionRef.current = confirmedRevision;
    clearSavedTimeout();

    if (savePhase !== "clean" || !revisionIncreased) {
      if (savePhase !== "clean") {
        setShowSaved(false);
      }
      return clearSavedTimeout;
    }

    setShowSaved(true);
    savedTimeoutRef.current = setTimeout(() => {
      savedTimeoutRef.current = null;
      setShowSaved(false);
    }, SAVED_INDICATOR_DURATION_MS);

    return clearSavedTimeout;
  }, [confirmedRevision, savePhase]);

  const status =
    savePhase === "pending"
      ? "Unsaved changes"
      : savePhase === "saving"
        ? "Saving…"
        : savePhase === "failed"
          ? "Save failed — retry"
          : showSaved
            ? "Saved"
            : cleanStatus;
  const statusClassName =
    savePhase === "failed" ? "ml-2 text-xs text-destructive" : "ml-2 text-xs text-muted-foreground";
  const saveActionClassName =
    savePhase === "failed"
      ? "text-destructive hover:text-destructive"
      : "text-muted-foreground hover:text-foreground";

  return (
    <div
      className="flex h-9 min-h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-3"
      data-file-editor-toolbar
    >
      <ToolbarAction
        className={saveActionClassName}
        disabled={!canSave}
        label="Save file"
        tooltip="Save file (Ctrl/Cmd+S)"
        onClick={onSave}
      >
        {savePhase === "saving" ? (
          <LoaderCircle className="animate-spin text-current" />
        ) : (
          <Save className="text-current" />
        )}
      </ToolbarAction>
      <ToolbarAction
        className="text-muted-foreground hover:text-foreground"
        disabled={!canUndo}
        label="Undo"
        tooltip="Undo (Ctrl/Cmd+Z)"
        onClick={onUndo}
      >
        <Undo2 className="text-current" />
      </ToolbarAction>
      <ToolbarAction
        className="text-muted-foreground hover:text-foreground"
        disabled={!canRedo}
        label="Redo"
        tooltip="Redo (Shift+Ctrl/Cmd+Z)"
        onClick={onRedo}
      >
        <Redo2 className="text-current" />
      </ToolbarAction>
      <span className={statusClassName} aria-live="polite">
        {status}
      </span>
    </div>
  );
}
