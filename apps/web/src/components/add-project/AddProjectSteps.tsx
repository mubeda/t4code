"use client";

import type { EnvironmentId } from "@t4code/contracts";
import { ChevronDownIcon, FolderOpenIcon, GitBranchIcon, GlobeIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";

import {
  joinProjectPath,
  validateAddProjectPath,
  validateProjectName,
  type AddProjectHostOption,
} from "./AddProjectDialog.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface AddProjectStartStepProps {
  readonly hosts: ReadonlyArray<AddProjectHostOption>;
  readonly selectedEnvironmentId: EnvironmentId;
  readonly busy: boolean;
  readonly onSelectHost: (environmentId: EnvironmentId) => void;
  readonly onBrowse: () => void;
  readonly onOpenClone: () => void;
  readonly onOpenCreate: () => void;
}

export interface AddProjectHostPathStepProps {
  readonly hostLabel: string;
  readonly path: string;
  readonly error: string | null;
  readonly busy: boolean;
  readonly onPathChange: (path: string) => void;
  readonly onSubmit: () => void;
}

export interface AddProjectCloneStepProps {
  readonly url: string;
  readonly parentDir: string;
  readonly error: string | null;
  readonly busy: boolean;
  readonly canPickParent: boolean;
  readonly onUrlChange: (url: string) => void;
  readonly onParentDirChange: (path: string) => void;
  readonly onPickParent: () => void;
  readonly onClone: () => void;
}

export interface AddProjectCreateStepProps {
  readonly name: string;
  readonly parentDir: string;
  readonly platform: string;
  readonly error: string | null;
  readonly busy: boolean;
  readonly canPickParent: boolean;
  readonly onNameChange: (name: string) => void;
  readonly onParentDirChange: (path: string) => void;
  readonly onPickParent: () => void;
  readonly onCreate: () => void;
}

function StepHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <header className="space-y-1">
      <h2 className="font-semibold text-2xl tracking-tight">{title}</h2>
      {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
    </header>
  );
}

function ErrorMessage({ children }: { readonly children: ReactNode }) {
  return (
    <p className="text-destructive text-xs" role="alert">
      {children}
    </p>
  );
}

function handleArrowNavigation(event: KeyboardEvent<HTMLDivElement>): void {
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-add-project-action]"),
  );
  const activeButton =
    document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;

  if (event.key === "Enter" && activeButton && buttons.includes(activeButton)) {
    event.preventDefault();
    activeButton.click();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (buttons.length === 0) return;

  const currentIndex = activeButton === null ? -1 : buttons.indexOf(activeButton);
  const fallbackIndex = event.key === "ArrowDown" ? 0 : buttons.length - 1;
  const nextIndex =
    currentIndex < 0
      ? fallbackIndex
      : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;

  event.preventDefault();
  buttons[nextIndex]?.focus();
}

function ActionRow({
  title,
  description,
  Icon,
  selected,
  busy,
  prominent = false,
  autoFocus = false,
  className,
  onClick,
  onFocus,
}: {
  readonly title: string;
  readonly description: string;
  readonly Icon: typeof FolderOpenIcon;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly prominent?: boolean;
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly onClick: () => void;
  readonly onFocus: () => void;
}) {
  return (
    <Button
      autoFocus={autoFocus}
      className={cn(
        "h-auto w-full justify-start gap-3 whitespace-normal px-3 py-2.5 text-left shadow-none",
        prominent ? "min-h-16" : "min-h-14 rounded-none border-transparent",
        selected
          ? "border-ring bg-accent text-accent-foreground focus-visible:ring-0"
          : prominent
            ? "border-input bg-background"
            : "bg-background hover:bg-accent/60",
        className,
      )}
      data-add-project-action
      disabled={busy}
      onClick={onClick}
      onFocus={onFocus}
      variant="ghost"
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md",
          prominent ? "bg-muted text-foreground" : "text-muted-foreground",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-sm">{title}</span>
        <span className="mt-0.5 block font-normal text-muted-foreground text-xs">
          {description}
        </span>
      </span>
      {selected ? (
        <span className="shrink-0" aria-hidden>
          <Kbd>↵</Kbd>
        </span>
      ) : null}
    </Button>
  );
}

export function AddProjectStartStep({
  hosts,
  selectedEnvironmentId,
  busy,
  onSelectHost,
  onBrowse,
  onOpenClone,
  onOpenCreate,
}: AddProjectStartStepProps) {
  const [focusedAction, setFocusedAction] = useState<"browse" | "clone" | "create" | null>(null);
  const hostItems = hosts.map((host) => ({
    value: host.environmentId,
    label: host.label,
  }));
  const actions = [
    {
      kind: "browse",
      title: "Browse folder",
      description: "Local project, Git repo, or folder",
      icon: FolderOpenIcon,
      run: onBrowse,
    },
    {
      kind: "clone",
      title: "Clone from URL",
      description: "Clone a remote Git repository",
      icon: GlobeIcon,
      run: onOpenClone,
    },
    {
      kind: "create",
      title: "Create new project",
      description: "Start from an empty folder",
      icon: PlusIcon,
      run: onOpenCreate,
    },
  ] as const;

  return (
    <div className="space-y-5">
      <StepHeading title="Add a project" />
      <div
        className="space-y-4"
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof HTMLButtonElement) ||
            !event.relatedTarget.matches("button[data-add-project-action]")
          ) {
            setFocusedAction(null);
          }
        }}
        onKeyDown={handleArrowNavigation}
      >
        <label className="flex items-center gap-3">
          <span className="font-medium text-muted-foreground text-sm">Host</span>
          <Select
            disabled={hosts.length <= 1}
            items={hostItems}
            modal={false}
            onValueChange={(value) => {
              if (value !== null) onSelectHost(value as EnvironmentId);
            }}
            value={selectedEnvironmentId}
          >
            <SelectTrigger aria-label="Host" className="w-auto min-w-40" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {hosts.map((host) => (
                <SelectItem key={host.environmentId} value={host.environmentId}>
                  {host.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>

        <ActionRow
          Icon={actions[0].icon}
          autoFocus
          busy={busy}
          description={actions[0].description}
          onClick={actions[0].run}
          onFocus={() => setFocusedAction(actions[0].kind)}
          prominent
          selected={focusedAction === actions[0].kind}
          title={actions[0].title}
        />

        <section className="space-y-1.5">
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
            Other ways to add
          </h3>
          <div className="overflow-hidden rounded-lg border border-input bg-background">
            {actions.slice(1).map((action, index) => (
              <ActionRow
                Icon={action.icon}
                busy={busy}
                description={action.description}
                key={action.kind}
                onClick={action.run}
                onFocus={() => setFocusedAction(action.kind)}
                selected={focusedAction === action.kind}
                title={action.title}
                {...(index > 0 ? { className: "border-t" } : {})}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function handleInputEnter(
  event: KeyboardEvent<HTMLInputElement>,
  canSubmit: boolean,
  submit: () => void,
): void {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  if (canSubmit) submit();
}

function ParentDirectoryField({
  id,
  value,
  busy,
  canPick,
  invalid,
  onChange,
  onPick,
  onKeyDown,
}: {
  readonly id: string;
  readonly value: string;
  readonly busy: boolean;
  readonly canPick: boolean;
  readonly invalid: boolean;
  readonly onChange: (path: string) => void;
  readonly onPick: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="font-medium text-muted-foreground text-xs" htmlFor={id}>
        Parent folder
      </label>
      <div className="flex gap-2">
        <Input
          aria-invalid={invalid || undefined}
          className="min-w-0 flex-1 font-mono"
          disabled={busy}
          id={id}
          nativeInput
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="~/projects/"
          spellCheck={false}
          value={value}
        />
        <Button
          aria-label="Choose parent folder"
          className="shrink-0"
          disabled={busy || !canPick}
          onClick={onPick}
          size="icon"
          title="Choose parent folder"
          variant="outline"
        >
          <FolderOpenIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function AddProjectHostPathStep({
  hostLabel,
  path,
  error,
  busy,
  onPathChange,
  onSubmit,
}: AddProjectHostPathStepProps) {
  const canSubmit = path.trim().length > 0 && !busy;

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <StepHeading
        description="Enter the absolute path to an existing project on this host."
        title={`Add project from ${hostLabel}`}
      />
      <div className="space-y-1.5">
        <label
          className="font-medium text-muted-foreground text-xs"
          htmlFor="add-project-host-path"
        >
          Project path
        </label>
        <Input
          aria-invalid={error !== null ? true : undefined}
          autoFocus
          className="font-mono"
          disabled={busy}
          id="add-project-host-path"
          nativeInput
          onChange={(event) => onPathChange(event.currentTarget.value)}
          onKeyDown={(event) => handleInputEnter(event, canSubmit, onSubmit)}
          placeholder="/path/to/project/on/host"
          spellCheck={false}
          value={path}
        />
      </div>
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <Button className="w-full" disabled={!canSubmit} size="lg" type="submit">
        {busy ? "Adding…" : "Add project"}
      </Button>
    </form>
  );
}

export function AddProjectCloneStep({
  url,
  parentDir,
  error,
  busy,
  canPickParent,
  onUrlChange,
  onParentDirChange,
  onPickParent,
  onClone,
}: AddProjectCloneStepProps) {
  const canSubmit = url.trim().length > 0 && parentDir.trim().length > 0 && !busy;
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) =>
    handleInputEnter(event, canSubmit, onClone);

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onClone();
      }}
    >
      <StepHeading
        description="Enter the Git URL and choose where to clone it."
        title="Clone from URL"
      />
      <div className="space-y-1.5">
        <label
          className="font-medium text-muted-foreground text-xs"
          htmlFor="add-project-clone-url"
        >
          Git URL
        </label>
        <Input
          aria-invalid={error !== null ? true : undefined}
          autoFocus
          disabled={busy}
          id="add-project-clone-url"
          nativeInput
          onChange={(event) => onUrlChange(event.currentTarget.value)}
          onKeyDown={onEnter}
          placeholder="https://github.com/user/repo.git"
          spellCheck={false}
          value={url}
        />
      </div>
      <ParentDirectoryField
        busy={busy}
        canPick={canPickParent}
        id="add-project-clone-parent"
        invalid={error !== null}
        onChange={onParentDirChange}
        onKeyDown={onEnter}
        onPick={onPickParent}
        value={parentDir}
      />
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <Button className="w-full" disabled={!canSubmit} size="lg" type="submit">
        {busy ? "Cloning…" : "Clone"}
      </Button>
    </form>
  );
}

function formatParentSummary(parentDir: string): string {
  const path = parentDir.trim();
  if (path === "/" || /^[a-z]:[\\/]$/i.test(path)) return path;
  return path.replace(/[\\/]+$/, "");
}

export function AddProjectCreateStep({
  name,
  parentDir,
  platform,
  error,
  busy,
  canPickParent,
  onNameChange,
  onParentDirChange,
  onPickParent,
  onCreate,
}: AddProjectCreateStepProps) {
  const [parentEditorOpen, setParentEditorOpen] = useState(false);
  const nameError = validateProjectName(name);
  const parentError = validateAddProjectPath(parentDir, platform);
  const targetPath =
    nameError === null && parentError === null ? joinProjectPath(parentDir, name, platform) : "";
  const canSubmit = nameError === null && parentError === null && !busy;
  const parentSummary = formatParentSummary(parentDir) || "location not selected";

  return (
    <form
      className="min-w-0 space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onCreate();
      }}
    >
      <StepHeading
        description="Name it and T4Code will create a real project with sensible defaults."
        title="Create a new project"
      />
      <div className="space-y-1.5">
        <label
          className="font-medium text-muted-foreground text-xs"
          htmlFor="add-project-create-name"
        >
          Name
        </label>
        <Input
          aria-invalid={(name.trim().length > 0 && nameError !== null) || undefined}
          autoComplete="off"
          autoFocus
          className="font-mono"
          disabled={busy}
          id="add-project-create-name"
          nativeInput
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder="my-project"
          spellCheck={false}
          value={name}
        />
        {name.trim().length > 0 && nameError ? <ErrorMessage>{nameError}</ErrorMessage> : null}
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/30">
        <button
          aria-expanded={parentEditorOpen}
          className="flex w-full min-w-0 items-start gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setParentEditorOpen((open) => !open)}
          type="button"
        >
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-background/60 text-muted-foreground">
            <GitBranchIcon className="size-3.5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-sm">
              Git repository in {parentSummary}
            </span>
            {targetPath ? (
              <span
                className="mt-0.5 block truncate font-mono text-muted-foreground text-xs"
                title={targetPath}
              >
                {targetPath}
              </span>
            ) : null}
          </span>
          <ChevronDownIcon
            className={cn(
              "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
              parentEditorOpen && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        {parentEditorOpen ? (
          <div className="space-y-2 border-border border-t px-3 py-3">
            <ParentDirectoryField
              busy={busy}
              canPick={canPickParent}
              id="add-project-create-parent"
              invalid={parentDir.trim().length > 0 && parentError !== null}
              onChange={onParentDirChange}
              onPick={onPickParent}
              value={parentDir}
            />
            {parentDir.trim().length > 0 && parentError ? (
              <ErrorMessage>{parentError}</ErrorMessage>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <Button className="w-full" disabled={!canSubmit} size="lg" type="submit">
        {busy ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}
