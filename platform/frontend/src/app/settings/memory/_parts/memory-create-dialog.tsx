"use client";

import { E2eTestId } from "@shared";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateMemory } from "@/lib/memory.query";
import {
  getMemoryKindLabel,
  getMemoryScopeLabel,
  type MemoryKind,
  type MemoryScopeType,
} from "./memory-utils";

type CreateDialogFormValues = {
  scopeType: MemoryScopeType;
  scopeId: string;
  kind: MemoryKind;
  content: string;
};

const MEMORY_KIND_OPTIONS: ReadonlyArray<MemoryKind> = [
  "preference",
  "profile_fact",
  "instruction",
  "team_convention",
  "org_fact",
];

const MEMORY_SCOPE_OPTIONS: ReadonlyArray<MemoryScopeType> = [
  "user",
  "team",
  "organization",
];

export function MemoryCreateDialog({
  open,
  onOpenChange,
  currentUserId,
  organizationId,
  teams,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUserId: string | null | undefined;
  organizationId: string | null | undefined;
  teams: Array<{ id: string; name: string }>;
}) {
  const createMemory = useCreateMemory();
  const form = useForm<CreateDialogFormValues>({
    defaultValues: {
      scopeType: "user",
      scopeId: currentUserId ?? "",
      kind: "preference",
      content: "",
    },
  });

  const selectedScopeType = form.watch("scopeType");

  const hasScopeTarget =
    selectedScopeType === "user"
      ? !!currentUserId
      : selectedScopeType === "organization"
        ? !!organizationId
        : !!form.watch("scopeId");

  const handleScopeTypeChange = (scopeType: MemoryScopeType) => {
    form.setValue("scopeType", scopeType);
    if (scopeType === "user") {
      form.setValue("scopeId", currentUserId ?? "");
      return;
    }
    if (scopeType === "organization") {
      form.setValue("scopeId", organizationId ?? "");
      return;
    }

    form.setValue("scopeId", teams[0]?.id ?? "");
  };

  const handleSubmit = form.handleSubmit(async (values) => {
    const content = values.content.trim();
    if (!content) return;

    const scopeId =
      values.scopeType === "user"
        ? currentUserId
        : values.scopeType === "organization"
          ? organizationId
          : values.scopeId;

    if (!scopeId) return;

    const created = await createMemory.mutateAsync({
      scopeType: values.scopeType,
      scopeId,
      kind: values.kind,
      content,
    });

    if (!created) {
      return;
    }

    onOpenChange(false);
    form.reset({
      scopeType: "user",
      scopeId: currentUserId ?? "",
      kind: "preference",
      content: "",
    });
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Propose memory"
      description="Create a memory candidate for review."
      size="medium"
    >
      <DialogForm onSubmit={handleSubmit}>
        <DialogBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="memory-create-scope">Scope</Label>
              <Select
                value={selectedScopeType}
                onValueChange={handleScopeTypeChange}
                disabled={createMemory.isPending}
              >
                <SelectTrigger id="memory-create-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_SCOPE_OPTIONS.map((scopeType) => (
                    <SelectItem key={scopeType} value={scopeType}>
                      {getMemoryScopeLabel(scopeType)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-create-kind">Kind</Label>
              <Select
                value={form.watch("kind")}
                onValueChange={(value: MemoryKind) =>
                  form.setValue("kind", value)
                }
                disabled={createMemory.isPending}
              >
                <SelectTrigger id="memory-create-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_KIND_OPTIONS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {getMemoryKindLabel(kind)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {selectedScopeType === "team" && (
            <div className="space-y-2">
              <Label htmlFor="memory-create-team">Team</Label>
              <Select
                value={form.watch("scopeId")}
                onValueChange={(value) => form.setValue("scopeId", value)}
                disabled={createMemory.isPending}
              >
                <SelectTrigger id="memory-create-team">
                  <SelectValue placeholder="Select team scope" />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="memory-create-content">Content</Label>
            <Textarea
              id="memory-create-content"
              value={form.watch("content")}
              onChange={(event) => form.setValue("content", event.target.value)}
              placeholder="Add concise, durable memory content"
              rows={6}
              maxLength={500}
              disabled={createMemory.isPending}
            />
          </div>
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              !form.watch("content").trim() ||
              !hasScopeTarget ||
              createMemory.isPending
            }
            data-testid={E2eTestId.MemoryCreateButton}
          >
            Propose memory
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
