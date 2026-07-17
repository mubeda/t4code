"use client";

import { ArrowLeftIcon } from "lucide-react";

import {
  AddProjectCloneStep,
  AddProjectCreateStep,
  AddProjectHostPathStep,
  AddProjectStartStep,
} from "./add-project/AddProjectSteps";
import { useAddProjectWorkflow } from "./add-project/useAddProjectWorkflow";
import { Dialog, DialogPopup } from "./ui/dialog";

export interface AddProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  const workflow = useAddProjectWorkflow({ open, onOpenChange });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!workflow.busy) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={!workflow.busy}>
        {workflow.step !== "start" ? (
          <button
            type="button"
            className="mx-6 mt-5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            disabled={workflow.busy}
            onClick={workflow.back}
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </button>
        ) : null}

        {workflow.step === "start" ? (
          <AddProjectStartStep
            hosts={workflow.hosts}
            selectedEnvironmentId={workflow.selectedHost.environmentId}
            busy={workflow.busy}
            onSelectHost={workflow.selectHost}
            onBrowse={() => void workflow.browse()}
            onOpenClone={workflow.openClone}
            onOpenCreate={workflow.openCreate}
          />
        ) : null}
        {workflow.step === "host-path" ? (
          <AddProjectHostPathStep
            hostLabel={workflow.selectedHost.label}
            path={workflow.hostPath}
            error={workflow.error}
            busy={workflow.busy}
            onPathChange={workflow.setHostPath}
            onSubmit={() => void workflow.submitHostPath()}
          />
        ) : null}
        {workflow.step === "clone" ? (
          <AddProjectCloneStep
            url={workflow.cloneUrl}
            parentDir={workflow.cloneParent}
            error={workflow.error}
            busy={workflow.busy}
            canPickParent={workflow.canPickParent}
            onUrlChange={workflow.setCloneUrl}
            onParentDirChange={workflow.setCloneParent}
            onPickParent={() => void workflow.pickCloneParent()}
            onClone={() => void workflow.submitClone()}
          />
        ) : null}
        {workflow.step === "create" ? (
          <AddProjectCreateStep
            name={workflow.createName}
            parentDir={workflow.createParent}
            platform={workflow.selectedHost.platform}
            error={workflow.error}
            busy={workflow.busy}
            canPickParent={workflow.canPickParent}
            onNameChange={workflow.setCreateName}
            onParentDirChange={workflow.setCreateParent}
            onPickParent={() => void workflow.pickCreateParent()}
            onCreate={() => void workflow.submitCreate()}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
