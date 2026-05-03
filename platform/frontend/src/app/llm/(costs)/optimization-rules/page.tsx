"use client";

import { providerDisplayNames } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Edit, Plus, Power, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSetCostsAction } from "@/app/llm/(costs)/layout";
import { OptimizationRuleForm } from "@/app/llm/(costs)/optimization-rules/_parts/rule";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderOptionLabel } from "@/components/llm-provider-options";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import type { OptimizationRule } from "@/lib/optimization-rule.query";
import {
  useCreateOptimizationRule,
  useDeleteOptimizationRule,
  useOptimizationRules,
  useUpdateOptimizationRule,
} from "@/lib/optimization-rule.query";
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

const DEFAULT_RULE = {
  entityType: "organization",
  entityId: "",
  conditions: [{ maxLength: 1000 }],
  provider: "openai",
  targetModel: "",
  enabled: true,
} satisfies Omit<OptimizationRule, "id" | "createdAt" | "updatedAt">;

type RuleDraft = Omit<OptimizationRule, "id" | "createdAt" | "updatedAt">;

function getProviderLogoName(provider: keyof typeof providerDisplayNames) {
  const logoNames = {
    openai: "openai",
    anthropic: "anthropic",
    gemini: "google",
    bedrock: "amazon-bedrock",
    cerebras: "cerebras",
    cohere: "cohere",
    mistral: "mistral",
    perplexity: "perplexity",
    groq: "groq",
    xai: "xai",
    openrouter: "openrouter",
    vllm: "vllm",
    ollama: "ollama-cloud",
    zhipuai: "zhipuai",
    deepseek: "deepseek",
    minimax: "minimax",
    azure: "azure",
  } as const;

  return logoNames[provider];
}

export default function OptimizationRulesPage() {
  const setActionButton = useSetCostsAction();
  const { data: rules = [], isPending } = useOptimizationRules();
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const { data: teams = [] } = useTeams();
  const { data: organization } = useOrganization();
  const createRule = useCreateOptimizationRule();
  const updateRule = useUpdateOptimizationRule();
  const deleteRule = useDeleteOptimizationRule();
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const appliedToFilter = searchParams.get("appliedTo") || "all";
  const providerFilter = searchParams.get("provider") || "all";
  const targetModelFilter = searchParams.get("targetModel") || "all";

  const [draft, setDraft] = useState<RuleDraft>(DEFAULT_RULE);
  const [editingRule, setEditingRule] = useState<OptimizationRule | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<OptimizationRule | null>(
    null,
  );
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const tokenPrices = useMemo(
    () =>
      modelsWithApiKeys.map((model) => ({
        model: model.modelId,
        provider: model.provider,
        pricePerMillionInput: model.pricePerMillionInput ?? "0",
        pricePerMillionOutput: model.pricePerMillionOutput ?? "0",
      })),
    [modelsWithApiKeys],
  );

  const modelOptions = useMemo(
    () =>
      tokenPrices.map((model) => ({
        value: model.model,
        model: model.model,
        provider: model.provider,
        pricePerMillionInput: model.pricePerMillionInput,
        pricePerMillionOutput: model.pricePerMillionOutput,
      })),
    [tokenPrices],
  );

  const handleCreateOpen = useCallback(() => {
    setEditingRule(null);
    setDraft(DEFAULT_RULE);
    setIsDialogOpen(true);
  }, []);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ optimizationRule: ["create"] }}
        onClick={handleCreateOpen}
      >
        <Plus className="h-4 w-4" />
        Add Rule
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [handleCreateOpen, setActionButton]);

  const columns = useMemo<ColumnDef<OptimizationRule>[]>(
    () => [
      {
        accessorKey: "enabled",
        header: "Status",
        cell: ({ row }) => (
          <Badge variant={row.original.enabled ? "secondary" : "outline"}>
            {row.original.enabled ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      {
        accessorKey: "entityId",
        header: "Applied to",
        cell: ({ row }) => {
          if (row.original.entityType === "organization") {
            return "Organization";
          }
          const team = teams.find(
            (candidate) => candidate.id === row.original.entityId,
          );
          return team?.name ?? "Unknown team";
        },
      },
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => (
          <LlmProviderOptionLabel
            icon={`https://models.dev/logos/${getProviderLogoName(row.original.provider)}.svg`}
            name={providerDisplayNames[row.original.provider]}
          />
        ),
      },
      {
        accessorKey: "targetModel",
        header: "Target model",
        cell: ({ row }) => row.original.targetModel,
      },
      {
        id: "conditions",
        header: "Conditions",
        cell: ({ row }) => (
          <div className="max-w-xl text-sm text-muted-foreground">
            {row.original.conditions
              .map((condition) =>
                "maxLength" in condition
                  ? `Max length ${condition.maxLength}`
                  : condition.hasTools
                    ? "Has tools"
                    : "No tools",
              )
              .join(" and ")}
          </div>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              {
                icon: <Power className="h-4 w-4" />,
                label: row.original.enabled ? "Disable rule" : "Enable rule",
                permissions: { optimizationRule: ["update"] },
                onClick: async () => {
                  await updateRule.mutateAsync({
                    id: row.original.id,
                    enabled: !row.original.enabled,
                  });
                },
              },
              {
                icon: <Edit className="h-4 w-4" />,
                label: "Edit rule",
                permissions: { optimizationRule: ["update"] },
                onClick: () => {
                  setEditingRule(row.original);
                  setDraft({
                    entityType: row.original.entityType,
                    entityId: row.original.entityId,
                    conditions: row.original.conditions,
                    provider: row.original.provider,
                    targetModel: row.original.targetModel,
                    enabled: row.original.enabled,
                  });
                  setIsDialogOpen(true);
                },
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete rule",
                permissions: { optimizationRule: ["delete"] },
                variant: "destructive",
                onClick: () => setRuleToDelete(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [teams, updateRule],
  );

  async function handleSubmit() {
    if (draft.entityType === "organization" && !organization?.id) {
      return;
    }

    const entityId =
      draft.entityType === "organization"
        ? (organization?.id ?? "")
        : draft.entityId;

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

  const filteredRules = useMemo(() => {
    return rules.filter((rule) => {
      const matchesAppliedTo =
        appliedToFilter === "all" || rule.entityType === appliedToFilter;
      const matchesProvider =
        providerFilter === "all" || rule.provider === providerFilter;
      const matchesTargetModel =
        targetModelFilter === "all" || rule.targetModel === targetModelFilter;
      return matchesAppliedTo && matchesProvider && matchesTargetModel;
    });
  }, [appliedToFilter, providerFilter, rules, targetModelFilter]);

  const hasActiveFilters =
    appliedToFilter !== "all" ||
    providerFilter !== "all" ||
    targetModelFilter !== "all";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Select
          value={appliedToFilter}
          onValueChange={(value) =>
            updateQueryParams({ appliedTo: value === "all" ? null : value })
          }
        >
          <SelectTrigger className="w-full sm:w-[220px]">
            <SelectValue placeholder="All applied to" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All applied to</SelectItem>
            <SelectItem value="organization">Organization</SelectItem>
            <SelectItem value="team">Team</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={providerFilter}
          onValueChange={(value) =>
            updateQueryParams({ provider: value === "all" ? null : value })
          }
        >
          <SelectTrigger className="w-full sm:w-[220px]">
            <SelectValue placeholder="All providers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {Object.entries(providerDisplayNames).map(([provider, name]) => (
              <SelectItem key={provider} value={provider}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <LlmModelSearchableSelect
          value={targetModelFilter}
          onValueChange={(value) =>
            updateQueryParams({ targetModel: value === "all" ? null : value })
          }
          options={modelOptions}
          placeholder="All target models"
          className="sm:max-w-[320px]"
          includeAllOption
          allLabel="All target models"
        />
      </div>

      <LoadingWrapper
        isPending={isPending}
        loadingFallback={<LoadingSpinner />}
      >
        <DataTable
          columns={columns}
          data={filteredRules}
          emptyMessage="No optimization rules configured yet"
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No optimization rules match your filters. Try adjusting your search."
          onClearFilters={() =>
            updateQueryParams({
              appliedTo: null,
              provider: null,
              targetModel: null,
            })
          }
        />
      </LoadingWrapper>

      <FormDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={
          editingRule ? "Edit optimization rule" : "Create optimization rule"
        }
        description="Configure when requests should route to a cheaper target model."
        size="small"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <DialogBody>
            <OptimizationRuleForm
              {...draft}
              tokenPrices={tokenPrices}
              teams={teams}
              onChange={setDraft}
              onToggle={(enabled) =>
                setDraft((current) => ({ ...current, enabled }))
              }
            />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !draft.targetModel ||
                createRule.isPending ||
                updateRule.isPending
              }
            >
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
