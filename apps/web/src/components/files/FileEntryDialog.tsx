import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * A single dialog covering the file-tree mutation prompts: "prompt" collects a name (New File/Folder,
 * Rename) and "confirm" gates a destructive action (Delete). The action callback is carried on the
 * request so FileBrowserPanel keeps the mutation logic and this component stays a dumb shell — it is
 * mounted by the panel (not the context menu, which unmounts on select) so the dialog survives.
 */
export type FileEntryDialogRequest =
  | {
      mode: "prompt";
      title: string;
      description?: string;
      label: string;
      initialValue: string;
      confirmLabel: string;
      /** Select only the base name (before the extension) on open, like a rename affordance. */
      selectBasename?: boolean;
      onSubmit: (value: string) => void;
    }
  | {
      mode: "confirm";
      title: string;
      description: string;
      confirmLabel: string;
      destructive?: boolean;
      onConfirm: () => void;
    };

export default function FileEntryDialog({
  request,
  onClose,
}: {
  request: FileEntryDialogRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {request ? <FileEntryDialogBody request={request} onClose={onClose} /> : null}
    </Dialog>
  );
}

function FileEntryDialogBody({
  request,
  onClose,
}: {
  request: FileEntryDialogRequest;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.mode === "prompt" ? request.initialValue : "");

  useEffect(() => {
    if (request.mode !== "prompt") return;
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const dotIndex = request.initialValue.lastIndexOf(".");
      if (request.selectBasename && dotIndex > 0) {
        input.setSelectionRange(0, dotIndex);
      } else {
        input.select();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request]);

  const trimmed = value.trim();
  const submitDisabled = request.mode === "prompt" && trimmed.length === 0;

  const submit = () => {
    if (request.mode === "prompt") {
      if (trimmed.length === 0) return;
      request.onSubmit(trimmed);
    } else {
      request.onConfirm();
    }
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!submitDisabled) submit();
    }
  };

  return (
    <DialogPopup className="max-w-md" onKeyDown={handleKeyDown}>
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        {request.description ? <DialogDescription>{request.description}</DialogDescription> : null}
      </DialogHeader>
      {request.mode === "prompt" ? (
        <DialogPanel>
          <label className="grid gap-1.5">
            <span className="text-foreground text-xs font-medium">{request.label}</span>
            <Input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        </DialogPanel>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={request.mode === "confirm" && request.destructive ? "destructive" : "default"}
          disabled={submitDisabled}
          onClick={submit}
        >
          {request.confirmLabel}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
