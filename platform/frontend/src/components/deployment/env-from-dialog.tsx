"use client";

import { useEffect, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type EnvFromType = "secret" | "configMap";

export interface EnvFromDraft {
  type: EnvFromType;
  name: string;
  prefix: string;
}

interface EnvFromDialogProps {
  open: boolean;
  mode: "add" | "edit";
  initial: EnvFromDraft | null;
  onClose: () => void;
  onConfirm: (draft: EnvFromDraft) => void;
}

const EMPTY_DRAFT: EnvFromDraft = { type: "secret", name: "", prefix: "" };

export function EnvFromDialog({
  open,
  mode,
  initial,
  onClose,
  onConfirm,
}: EnvFromDialogProps) {
  const [draft, setDraft] = useState<EnvFromDraft>(initial ?? EMPTY_DRAFT);

  useEffect(() => {
    if (open) setDraft(initial ?? EMPTY_DRAFT);
  }, [open, initial]);

  const canSubmit = draft.name.trim().length > 0;

  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      title={mode === "add" ? "Add source" : "Edit source"}
      description={
        mode === "add"
          ? "Inject all keys from an existing k8s Secret or ConfigMap as environment variables."
          : undefined
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onConfirm({
                ...draft,
                name: draft.name.trim(),
                prefix: draft.prefix.trim(),
              })
            }
          >
            {mode === "add" ? "Add source" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="env-from-type">Type</Label>
          <Select
            value={draft.type}
            onValueChange={(v) =>
              setDraft((prev) => ({ ...prev, type: v as EnvFromType }))
            }
          >
            <SelectTrigger id="env-from-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="secret">Secret</SelectItem>
              <SelectItem value="configMap">ConfigMap</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="env-from-name">Name</Label>
          <Input
            id="env-from-name"
            value={draft.name}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, name: e.target.value }))
            }
            placeholder="my-k8s-secret"
            className="font-mono"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="env-from-prefix">Prefix (optional)</Label>
          <Input
            id="env-from-prefix"
            value={draft.prefix}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, prefix: e.target.value }))
            }
            placeholder="e.g. MY_PREFIX_"
            className="font-mono"
          />
        </div>
      </div>
    </StandardDialog>
  );
}
