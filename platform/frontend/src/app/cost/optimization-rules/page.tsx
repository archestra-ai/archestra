"use client";

import { Edit, Plus, Save, Trash2, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Rule } from "@/app/cost/optimization-rules/_parts/rule";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { Separator } from "@/components/ui/separator";
import type { OptimizationRule } from "@/lib/optimization-rule.query";
import {
  useCreateOptimizationRule,
  useDeleteOptimizationRule,
  useOptimizationRules,
  useUpdateOptimizationRule,
} from "@/lib/optimization-rule.query";
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/team.query";
import { useTokenPrices } from "@/lib/token-price.query";
import { cn } from "@/lib/utils";

// Form data type for inline editing
type RuleFormData = Omit<OptimizationRule, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

function LoadingSkeleton({ count, prefix }: { count: number; prefix: string }) {
  const skeletons = Array.from(
    { length: count },
    (_, i) => `${prefix}-skeleton-${i}`,
  );

  return (
    <div className="space-y-3">
      {skeletons.map((key) => (
        <div key={key} className="h-16 bg-muted animate-pulse rounded" />
      ))}
    </div>
  );
}

// Helper to check if a rule has valid pricing
function hasValidPricing(
  rule: OptimizationRule,
  tokenPrices: Array<{
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  }>,
): boolean {
  const modelPricing = tokenPrices.find((m) => m.model === rule.targetModel);
  return (
    !!modelPricing &&
    (modelPricing.pricePerMillionInput !== "0" ||
      modelPricing.pricePerMillionOutput !== "0")
  );
}

// Delete confirmation modal component
function DeleteRuleConfirmation({
  ruleId,
  onDelete,
  disabled,
}: {
  ruleId: string;
  onDelete: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <PermissionButton
          permissions={{ limit: ["delete"] }}
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={disabled}
        >
          <Trash2 className="h-4 w-4" />
        </PermissionButton>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Optimization Rule</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this optimization rule? This action
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onDelete(ruleId)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function OptimizationRulesPage() {
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editedRuleData, setEditedRuleData] =
    useState<Partial<RuleFormData> | null>(null);
  const [newRuleData, setNewRuleData] = useState<RuleFormData | null>(null);
  const [ruleOrder, setRuleOrder] = useState<string[]>([]);
  const hasInitialized = useRef(false);
  const editedRuleDataRef = useRef<Partial<RuleFormData> | null>(null);

  const { data: allRules = [], isLoading: rulesLoading } =
    useOptimizationRules();
  const { data: tokenPrices = [] } = useTokenPrices();
  const { data: teams = [] } = useTeams();
  const { data: organization } = useOrganization();

  const createRule = useCreateOptimizationRule();
  const updateRule = useUpdateOptimizationRule();
  const deleteRule = useDeleteOptimizationRule();

  // Initialize order on first load, then maintain it
  useEffect(() => {
    if (!hasInitialized.current && allRules.length > 0) {
      // Initialize with current order from backend
      setRuleOrder(allRules.map((rule) => rule.id));
      hasInitialized.current = true;
    } else if (hasInitialized.current) {
      setRuleOrder((ruleOrder) => {
        const newRules = allRules.filter(
          (rule) => !ruleOrder.includes(rule.id),
        );
        if (newRules.length === 0) return ruleOrder;

        // Add new rules to the end, preserving existing order
        return [...ruleOrder, ...newRules.map((rule) => rule.id)];
      });
    }
  }, [allRules]);

  // Derive ordered rules from rule order and actual data
  const orderedRules = ruleOrder
    .map((id) => allRules.find((rule) => rule.id === id))
    .filter((rule): rule is OptimizationRule => rule !== undefined);

  // Create a pending rule when adding a new rule
  const pendingRule: OptimizationRule | null = newRuleData
    ? { ...newRuleData, id: "", createdAt: "", updatedAt: "" }
    : null;

  // Combine existing rules with pending rule
  const allDisplayRules = pendingRule
    ? [...orderedRules, pendingRule]
    : orderedRules;

  const handleCreateRule = useCallback(
    async (data: RuleFormData) => {
      const entityId =
        data.entityType === "organization"
          ? (organization?.id ?? "")
          : data.entityId;
      const result = await createRule.mutateAsync({ ...data, entityId });
      if (result) {
        setNewRuleData(null);
      }
    },
    [createRule, organization?.id],
  );

  const handleDeleteRule = useCallback(
    async (id: string) => {
      await deleteRule.mutateAsync(id);
    },
    [deleteRule],
  );

  const handleToggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      await updateRule.mutateAsync({ id, enabled });
    },
    [updateRule],
  );

  // Keep ref in sync with state
  useEffect(() => {
    editedRuleDataRef.current = editedRuleData;
  }, [editedRuleData]);

  const handleSaveEdit = useCallback(async () => {
    // Use ref to get the latest data, avoiding stale state from batched updates
    const dataToSave = editedRuleDataRef.current;
    if (!editingRuleId || !dataToSave) return;

    const entityId =
      dataToSave.entityType === "organization"
        ? (organization?.id ?? "")
        : dataToSave.entityId;
    const result = await updateRule.mutateAsync({
      ...dataToSave,
      id: editingRuleId,
      entityId,
    });
    if (result) {
      setEditingRuleId(null);
      setEditedRuleData(null);
      editedRuleDataRef.current = null;
    }
  }, [editingRuleId, updateRule, organization?.id]);

  const handleCancelEdit = useCallback(() => {
    setEditingRuleId(null);
    setEditedRuleData(null);
    editedRuleDataRef.current = null;
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Optimization Rules</CardTitle>
            <CardDescription>
              Add rules to select a cheaper model if content is short or there
              are no tools
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <PermissionButton
              permissions={{ limit: ["create"] }}
              onClick={() => {
                if (editingRuleId !== null) {
                  setEditingRuleId(null);
                }
                setNewRuleData({
                  entityType: "organization",
                  entityId: "",
                  conditions: [{ maxLength: 1000 }],
                  provider: "openai",
                  targetModel: "",
                  enabled: true,
                });
              }}
              size="sm"
              variant={newRuleData !== null ? "secondary" : "default"}
              disabled={editingRuleId !== null || newRuleData !== null}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Rule
            </PermissionButton>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {rulesLoading ? (
          <LoadingSkeleton count={3} prefix="optimization-rules" />
        ) : (
          <div className="space-y-4">
            {allDisplayRules.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No optimization rules configured for this organization
              </div>
            ) : (
              allDisplayRules.map((rule, index, rules) => {
                const isPending = rule.id === "";
                const isEditing = !isPending && editingRuleId === rule.id;
                const isOtherEditing =
                  (editingRuleId !== null && !isEditing) ||
                  (newRuleData !== null && !isPending);

                const handleSubmit = async (e: React.FormEvent) => {
                  e.preventDefault();
                  if (isPending && newRuleData) {
                    await handleCreateRule(newRuleData);
                  } else if (isEditing) {
                    await handleSaveEdit();
                  }
                };

                const handleKeyDown = (e: React.KeyboardEvent) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (isPending) {
                      setNewRuleData(null);
                    } else if (isEditing) {
                      handleCancelEdit();
                    }
                  } else if (e.key === "Enter") {
                    const target = e.target as HTMLElement;
                    // If Enter is pressed on a button (like SelectTrigger), submit the form
                    // unless it's the submit button itself (which will trigger naturally)
                    if (
                      target.getAttribute("role") === "combobox" ||
                      target.tagName === "BUTTON"
                    ) {
                      const canSubmit = isPending
                        ? newRuleData?.targetModel
                        : editedRuleData?.targetModel;
                      const isSubmitButton =
                        target instanceof HTMLButtonElement &&
                        target.type === "submit";
                      if (canSubmit && !isSubmitButton) {
                        e.preventDefault();
                        // Trigger form submission programmatically
                        const form = e.currentTarget as HTMLFormElement;
                        form.requestSubmit();
                      }
                    }
                  }
                };

                const content = (
                  <>
                    <Rule
                      {...rule}
                      tokenPrices={tokenPrices}
                      teams={teams}
                      editable={isPending || isEditing}
                      onChange={(data) =>
                        isPending
                          ? setNewRuleData(data)
                          : setEditedRuleData(data)
                      }
                      onToggle={(enabled) =>
                        isPending && newRuleData
                          ? setNewRuleData({ ...newRuleData, enabled })
                          : handleToggleEnabled(rule.id, enabled)
                      }
                      switchDisabled={isOtherEditing}
                      className="flex-1"
                    />
                    <div className="flex items-center gap-2">
                      {isPending ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!newRuleData?.targetModel}
                            onClick={(e) => {
                              e.preventDefault();
                              handleSubmit(e as unknown as React.FormEvent);
                            }}
                            className="text-primary hover:text-primary"
                          >
                            <Save className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setNewRuleData(null)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </>
                      ) : isEditing ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.preventDefault();
                              handleSubmit(e as unknown as React.FormEvent);
                            }}
                            className="text-primary hover:text-primary"
                          >
                            <Save className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handleCancelEdit}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <PermissionButton
                            permissions={{ limit: ["update"] }}
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditingRuleId(rule.id);
                              setEditedRuleData({
                                entityType: rule.entityType,
                                entityId: rule.entityId,
                                conditions: rule.conditions,
                                provider: rule.provider,
                                targetModel: rule.targetModel,
                                enabled: rule.enabled,
                              });
                            }}
                            disabled={isOtherEditing}
                          >
                            <Edit className="h-4 w-4" />
                          </PermissionButton>
                          <DeleteRuleConfirmation
                            ruleId={rule.id}
                            onDelete={handleDeleteRule}
                            disabled={isOtherEditing}
                          />
                        </>
                      )}
                    </div>
                  </>
                );

                const ruleHasValidPricing = hasValidPricing(rule, tokenPrices);

                return (
                  <React.Fragment key={rule.id}>
                    {isPending || isEditing ? (
                      <form
                        onSubmit={handleSubmit}
                        onKeyDown={handleKeyDown}
                        className={cn(
                          "flex items-center gap-2",
                          isOtherEditing && "opacity-40",
                        )}
                      >
                        {content}
                      </form>
                    ) : (
                      <div
                        className={cn(
                          "flex items-center gap-2",
                          isOtherEditing && "opacity-40",
                          !ruleHasValidPricing && "opacity-60",
                        )}
                      >
                        {content}
                      </div>
                    )}
                    {index !== rules.length - 1 ? (
                      <Separator className="my-4" />
                    ) : (
                      ""
                    )}
                  </React.Fragment>
                );
              })
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
