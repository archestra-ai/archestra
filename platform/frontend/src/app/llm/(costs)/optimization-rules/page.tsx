"use client";

import { Edit, Plus, Power, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Rule } from "@/app/llm/(costs)/optimization-rules/_parts/rule";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import { useSetCostsAction } from "@/app/llm/(costs)/layout";
import { useModelsWithApiKeys } from "@/lib/chat-models.query";
import type { OptimizationRule } from "@/lib/optimization-rule.query";
import {
  useCreateOptimizationRule,
  useDeleteOptimizationRule,
  useOptimizationRules,
  useUpdateOptimizationRule,
} from "@/lib/optimization-rule.query";
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/team.query";

const DEFAULT_RULE = {
  entityType: "organization",
  entityId: "",
  conditions: [{ maxLength: 1000 }],
  provider: "openai",
  targetModel: "",
  enabled: true,
} satisfies Omit<OptimizationRule, "id" | "createdAt" | "updatedAt">;

type RuleDraft = Omit<OptimizationRule, "id" | "createdAt" | "updatedAt">;

export default function OptimizationRulesPage() {
  const setActionButton = useSetCostsAction();
  const { data: rules = [], isPending } = useOptimizationRules();
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const { data: teams = [] } = useTeams();
  const { data: organization } = useOrganization();
  const createRule = useCreateOptimizationRule();
  const updateRule = useUpdateOptimizationRule();
  const deleteRule = useDeleteOptimizationRule();

  const [draft, setDraft] = useState<RuleDraft>(DEFAULT_RULE);
  const [editingRule, setEditingRule] = useState<OptimizationRule | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<OptimizationRule | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const tokenPrices = useMemo(
    () =>
      modelsWithApiKeys.map((model) => ({
        model: model.modelId,
        provider: model.provider,
        pricePerMillionInput: model.capabilities?.pricePerMillionInput ?? "0",
        pricePerMillionOutput: model.capabilities?.pricePerMillionOutput ?? "0",
      })),
    [modelsWithApiKeys],
  );

  useEffect(() => {
    setActionButton(
      <PermissionButton permissions={{ llmLimit: ["create"] }} onClick={handleCreateOpen}>
        <Plus className="mr-2 h-4 w-4" />
        Add Rule
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton]);

  function handleCreateOpen() {
    setEditingRule(null);
    setDraft(DEFAULT_RULE);
    setIsDialogOpen(true);
  }

  function handleEditOpen(rule: OptimizationRule) {
    setEditingRule(rule);
    setDraft({
      entityType: rule.entityType,
      entityId: rule.entityId,
      conditions: rule.conditions,
      provider: rule.provider,
      targetModel: rule.targetModel,
      enabled: rule.enabled,
    });
    setIsDialogOpen(true);
  }

  async function handleSubmit() {
    const entityId =
      draft.entityType === "organization" ? (organization?.id ?? "") : draft.entityId;

    if (editingRule) {
      const result = await updateRule.mutateAsync({
        id: editingRule.id,
        ...draft,
        entityId,
      });
      if (result) {
        setIsDialogOpen(false);
        setEditingRule(null);
      }
      return;
    }

    const result = await createRule.mutateAsync({
      ...draft,
      entityId,
    });
    if (result) {
      setIsDialogOpen(false);
    }
  }

  async function handleDelete() {
    if (!ruleToDelete) return;
    await deleteRule.mutateAsync(ruleToDelete.id);
    setRuleToDelete(null);
  }

  return (
    <div className="space-y-4">
      <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
        {rules.length === 0 ? (
          <div className="rounded-md border px-6 py-12 text-center text-sm text-muted-foreground">
            No optimization rules configured yet.
          </div>
        ) : (
          <div className="space-y-4">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-start justify-between gap-4 rounded-md border px-4 py-4">
                <Rule {...rule} tokenPrices={tokenPrices} teams={teams} className="min-w-0 flex-1" />
                <TableRowActions
                  actions={[
                    {
                      icon: <Power className="h-4 w-4" />,
                      label: rule.enabled ? "Disable rule" : "Enable rule",
                      onClick: async () => {
                        await updateRule.mutateAsync({ id: rule.id, enabled: !rule.enabled });
                      },
                    },
                    {
                      icon: <Edit className="h-4 w-4" />,
                      label: "Edit rule",
                      onClick: () => handleEditOpen(rule),
                    },
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete rule",
                      variant: "destructive",
                      onClick: () => setRuleToDelete(rule),
                    },
                  ]}
                />
              </div>
            ))}
          </div>
        )}
      </LoadingWrapper>

      <FormDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={editingRule ? "Edit optimization rule" : "Create optimization rule"}
        description="Configure when requests should route to a cheaper target model."
        size="large"
      >
        <DialogForm className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}>
          <DialogBody>
            <Rule
              {...draft}
              id="draft"
              tokenPrices={tokenPrices}
              teams={teams}
              editable
              onChange={setDraft}
              onToggle={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              className="flex-col items-start gap-4"
            />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!draft.targetModel || createRule.isPending || updateRule.isPending}>
              {editingRule ? "Save changes" : "Create rule"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!ruleToDelete}
        onOpenChange={(open) => !open && setRuleToDelete(null)}
        title="Delete optimization rule"
        description="This action cannot be undone."
        isPending={deleteRule.isPending}
        onConfirm={handleDelete}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
    </div>
  );
}
