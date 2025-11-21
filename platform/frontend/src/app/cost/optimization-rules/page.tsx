"use client";

import { Edit, Info, Plus, Save, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WithPermissions } from "@/components/roles/with-permissions";
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
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  CreateOptimizationRuleInput,
  OptimizationRule,
} from "@/lib/optimization-rule.query";
import {
  useCreateOptimizationRule,
  useDeleteOptimizationRule,
  useOptimizationRules,
  useUpdateOptimizationRule,
} from "@/lib/optimization-rule.query";
import { useTokenPrices } from "@/lib/token-price.query";

// Form data type for inline editing - uses strings for number inputs
type RuleFormData = {
  id?: string;
  ruleType: OptimizationRule["ruleType"];
  maxLength?: string;
  hasTools?: boolean;
  provider: OptimizationRule["provider"];
  targetModel: string;
  priority: string;
  enabled: boolean;
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

// Helper to convert form data to API input format
function formDataToConditions(
  data: RuleFormData,
): CreateOptimizationRuleInput["conditions"] {
  return data.ruleType === "content_length"
    ? { maxLength: Number(data.maxLength) }
    : { hasTools: data.hasTools ?? false };
}

// Helper to infer provider from model name
function getProviderFromModel(model: string): "anthropic" | "openai" | null {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1-")) return "openai";
  return null;
}

// Helper to format provider name for display
function formatProviderName(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return provider;
}

// Sort optimization rules: enabled first, then by priority (highest first)
function sortOptimizationRules(rules: OptimizationRule[]): OptimizationRule[] {
  return [...rules].sort((a, b) => {
    if (a.enabled !== b.enabled) {
      return a.enabled ? -1 : 1;
    }
    return a.priority - b.priority;
  });
}

// Sort models by total cost (input + output price) ascending
function sortModelsByPrice(
  tokenPrices: Array<{
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  }>,
): Array<{
  model: string;
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
}> {
  return [...tokenPrices].sort((a, b) => {
    const costA =
      parseFloat(a.pricePerMillionInput) + parseFloat(a.pricePerMillionOutput);
    const costB =
      parseFloat(b.pricePerMillionInput) + parseFloat(b.pricePerMillionOutput);
    return costA - costB;
  });
}

// Model Selector Component
function ModelSelector({
  value,
  provider,
  tokenPrices,
  onChange,
}: {
  value: string;
  provider: OptimizationRule["provider"];
  tokenPrices: Array<{
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  }>;
  onChange: (model: string) => void;
}) {
  const models = sortModelsByPrice(
    tokenPrices.filter(
      (price) => getProviderFromModel(price.model) === provider,
    ),
  );

  // Check if current value has pricing
  const currentModelHasPricing = models.some((m) => m.model === value);

  // If current value doesn't have pricing but exists, add it to the list
  const modelsWithCurrent =
    value && !currentModelHasPricing
      ? [
          {
            model: value,
            pricePerMillionInput: "0",
            pricePerMillionOutput: "0",
          },
          ...models,
        ]
      : models;

  // Auto-select first (cheapest) model if no value provided or provider changed
  useEffect(() => {
    if (!value && models.length > 0) {
      onChange(models[0].model);
    }
  }, [models, value, onChange]);

  // If no models available for this provider, show message
  if (modelsWithCurrent.length === 0) {
    return (
      <div className="px-2 flex gap-2 text-sm whitespace-nowrap">
        <span className="text-muted-foreground">
          No pricing configured for {formatProviderName(provider)} models.
        </span>
        <Link
          href="/cost/token-price"
          className="hover:text-foreground hover:underline"
        >
          Add pricing
        </Link>
      </div>
    );
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select target model" />
      </SelectTrigger>
      <SelectContent>
        {modelsWithCurrent.map((price) => {
          const hasPricing =
            price.pricePerMillionInput !== "0" ||
            price.pricePerMillionOutput !== "0";
          return (
            <SelectItem
              key={price.model}
              value={price.model}
              className={!hasPricing ? "text-muted-foreground" : ""}
            >
              {price.model}
              {hasPricing
                ? ` ($${price.pricePerMillionInput} / $${price.pricePerMillionOutput})`
                : " (no pricing)"}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

// Inline Form Component for adding/editing optimization rules
function OptimizationRuleInlineForm({
  initialData,
  onSave,
  onCancel,
  tokenPrices,
}: {
  initialData?: RuleFormData;
  onSave: (data: RuleFormData) => void;
  onCancel: () => void;
  tokenPrices: Array<{
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  }>;
}) {
  const [formData, setFormData] = useState<RuleFormData>({
    id: initialData?.id,
    ruleType: initialData?.ruleType || "content_length",
    maxLength: initialData?.maxLength || "1000",
    hasTools: initialData?.hasTools ?? false,
    provider: initialData?.provider || "openai",
    targetModel: initialData?.targetModel || "",
    priority: initialData?.priority || "1",
    enabled: initialData?.enabled ?? true,
  });

  const handleSubmit = useCallback(() => {
    onSave(formData);
  }, [formData, onSave]);

  const isValid =
    formData.ruleType &&
    (formData.ruleType === "content_length"
      ? formData.maxLength
      : formData.hasTools !== undefined) &&
    formData.provider &&
    formData.targetModel &&
    formData.priority;

  return (
    <TableRow className="bg-muted/30">
      <TableCell className="w-16">
        <Switch
          checked={formData.enabled}
          onCheckedChange={(checked) =>
            setFormData({ ...formData, enabled: checked })
          }
        />
      </TableCell>
      <TableCell className="p-2">
        <div className="flex gap-2 items-center">
          <Select
            value={formData.ruleType}
            onValueChange={(value: "content_length" | "tool_presence") =>
              setFormData({ ...formData, ruleType: value })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="content_length">Content Length</SelectItem>
              <SelectItem value="tool_presence">Tool Presence</SelectItem>
            </SelectContent>
          </Select>
          {formData.ruleType === "content_length" ? (
            <>
              Max:
              <Input
                id="maxLength"
                type="number"
                min="0"
                className="w-[10em]"
                value={formData.maxLength}
                onChange={(e) =>
                  setFormData({ ...formData, maxLength: e.target.value })
                }
                placeholder="1000"
                required
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (isValid) handleSubmit();
                  }
                }}
              />
            </>
          ) : (
            <Select
              value={formData.hasTools ? "true" : "false"}
              onValueChange={(value) =>
                setFormData({ ...formData, hasTools: value === "true" })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">With tools</SelectItem>
                <SelectItem value="false">Without tools</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </TableCell>
      <TableCell className="p-2">
        <Select
          value={formData.provider}
          onValueChange={(value) =>
            setFormData({
              ...formData,
              provider: value as OptimizationRule["provider"],
              targetModel: "",
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic">Anthropic</SelectItem>
            <SelectItem value="openai">OpenAI</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="p-2">
        <ModelSelector
          value={formData.targetModel}
          provider={formData.provider}
          tokenPrices={tokenPrices}
          onChange={(value) => setFormData({ ...formData, targetModel: value })}
        />
      </TableCell>
      <TableCell className="p-2 w-20">
        <Input
          id="priority"
          type="number"
          min="1"
          value={formData.priority}
          onChange={(e) =>
            setFormData({ ...formData, priority: e.target.value })
          }
          placeholder="1"
          required
          className="w-full"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (isValid) handleSubmit();
            }
          }}
        />
      </TableCell>
      <TableCell className="p-2">
        <div className="flex gap-2">
          <Button
            onClick={() => handleSubmit()}
            disabled={!isValid}
            size="sm"
            variant="ghost"
          >
            <Save className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} size="sm">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// Optimization Rule Row Component for displaying/editing individual rules
function OptimizationRuleRow({
  rule,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onToggleEnabled,
  tokenPrices,
}: {
  rule: OptimizationRule;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (data: RuleFormData) => void;
  onCancel: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  tokenPrices: Array<{
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  }>;
}) {
  const hasModelPricing = tokenPrices.some(
    (price) => price.model === rule.targetModel,
  );

  if (isEditing) {
    const formData: RuleFormData = {
      id: rule.id,
      ruleType: rule.ruleType,
      maxLength:
        rule.ruleType === "content_length"
          ? String((rule.conditions as { maxLength: number }).maxLength)
          : undefined,
      hasTools:
        rule.ruleType === "tool_presence"
          ? (rule.conditions as { hasTools: boolean }).hasTools
          : undefined,
      provider: rule.provider,
      targetModel: rule.targetModel,
      priority: String(rule.priority),
      enabled: rule.enabled,
    };

    return (
      <OptimizationRuleInlineForm
        initialData={formData}
        onSave={onSave}
        onCancel={onCancel}
        tokenPrices={tokenPrices}
      />
    );
  }

  return (
    <TableRow
      className={`hover:bg-muted/30 ${!hasModelPricing ? "text-muted-foreground" : ""}`}
    >
      <TableCell className="w-16">
        <div className={!hasModelPricing ? "opacity-50" : ""}>
          <WithPermissions permissions={{ limit: ["update"] }}>
            <Switch checked={rule.enabled} onCheckedChange={onToggleEnabled} />
          </WithPermissions>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {rule.ruleType === "content_length"
          ? `Content length: Max ${(rule.conditions as { maxLength: number }).maxLength} chars`
          : `Tool presence: ${(rule.conditions as { hasTools: boolean }).hasTools ? "With tools" : "Without tools"}`}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {formatProviderName(rule.provider)}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex gap-2 items-center">
          {rule.targetModel}
          {!hasModelPricing && (
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-70 text-wrap">
                    <p>
                      No pricing configured for this model. This rule will not
                      be applied. Add pricing on the Token Price page.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Link
                href="/cost/token-price"
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Add pricing
              </Link>
            </>
          )}
        </div>
      </TableCell>
      <TableCell>{rule.priority}</TableCell>
      <TableCell className="pl-2 text-foreground">
        <div className="flex items-center gap-2">
          <PermissionButton
            permissions={{ limit: ["update"] }}
            variant="ghost"
            size="sm"
            onClick={onEdit}
          >
            <Edit className="h-4 w-4" />
          </PermissionButton>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <PermissionButton
                permissions={{ limit: ["delete"] }}
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </PermissionButton>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Optimization Rule</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this optimization rule? This
                  action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function OptimizationRulesPage() {
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [isAddingRule, setIsAddingRule] = useState(false);
  const [ruleOrder, setRuleOrder] = useState<string[]>([]);
  const hasInitialized = useRef(false);

  const { data: allRules = [], isLoading: rulesLoading } =
    useOptimizationRules();
  const { data: tokenPrices = [] } = useTokenPrices();

  const createRule = useCreateOptimizationRule();
  const updateRule = useUpdateOptimizationRule();
  const deleteRule = useDeleteOptimizationRule();

  // Sort rules once on initial load, then maintain order
  useEffect(() => {
    if (!hasInitialized.current && allRules.length > 0) {
      // Initial sort: enabled first, then by priority (highest first)
      const sorted = sortOptimizationRules(allRules);
      setRuleOrder(sorted.map((rule) => rule.id));
      hasInitialized.current = true;
    } else if (hasInitialized.current) {
      setRuleOrder((ruleOrder) => {
        const newRuleIds = allRules
          .filter((rule) => !ruleOrder.includes(rule.id))
          .map((rule) => rule.id);
        return [...newRuleIds, ...ruleOrder];
      });
    }
  }, [allRules]);

  // Derive ordered rules from rule order and actual data
  const orderedRules = ruleOrder
    .map((id) => allRules.find((rule) => rule.id === id))
    .filter((rule): rule is OptimizationRule => rule !== undefined);

  const handleCreateRule = useCallback(
    async (data: RuleFormData) => {
      try {
        await createRule.mutateAsync({
          ruleType: data.ruleType,
          conditions: formDataToConditions(data),
          provider: data.provider,
          targetModel: data.targetModel,
          priority: Number(data.priority),
          enabled: data.enabled,
        });
        setIsAddingRule(false);
        toast.success("Optimization rule created");
      } catch (_error) {
        toast.error("Failed to create optimization rule");
      }
    },
    [createRule],
  );

  const handleUpdateRule = useCallback(
    async (id: string, data: RuleFormData) => {
      try {
        await updateRule.mutateAsync({
          id,
          ruleType: data.ruleType,
          conditions: formDataToConditions(data),
          provider: data.provider,
          targetModel: data.targetModel,
          priority: Number(data.priority),
          enabled: data.enabled,
        });
        setEditingRuleId(null);
        toast.success("Optimization rule updated");
      } catch (_error) {
        toast.error("Failed to update optimization rule");
      }
    },
    [updateRule],
  );

  const handleDeleteRule = useCallback(
    async (id: string) => {
      try {
        await deleteRule.mutateAsync(id);
        toast.success("Optimization rule deleted");
      } catch (_error) {
        toast.error("Failed to delete optimization rule");
      }
    },
    [deleteRule],
  );

  const handleToggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await updateRule.mutateAsync({
          id,
          enabled,
        });
        toast.success(`Optimization rule ${enabled ? "enabled" : "disabled"}`);
      } catch (_error) {
        toast.error("Failed to toggle optimization rule");
      }
    },
    [updateRule],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingRuleId(null);
    setIsAddingRule(false);
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
                setIsAddingRule(true);
              }}
              size="sm"
              variant="default"
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
          <Table>
            <TableHeader>
              <TableRow className="whitespace-nowrap">
                <TableHead className="w-16">Enabled</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead className="w-32">Provider</TableHead>
                <TableHead>
                  <div className="flex items-center gap-1">
                    Target Model
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-70 text-wrap">
                          <p>
                            Only models with configured pricing can be selected.
                            Add pricing for more models on the Token Price page.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </TableHead>
                <TableHead className="w-20">
                  <div className="flex items-center gap-1">
                    Order
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-70 text-wrap">
                          <p>
                            Rules are evaluated in order (1, 2, 3...). The first
                            matching rule is applied. If no rules match, the
                            original model is used.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </TableHead>
                <TableHead className="w-48">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isAddingRule && (
                <OptimizationRuleInlineForm
                  initialData={{
                    ruleType: "content_length",
                    provider: "anthropic",
                    targetModel: "",
                    priority: "1",
                    enabled: true,
                  }}
                  onSave={handleCreateRule}
                  onCancel={handleCancelEdit}
                  tokenPrices={tokenPrices}
                />
              )}
              {orderedRules.length === 0 && !isAddingRule ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No optimization rules configured for this organization
                  </TableCell>
                </TableRow>
              ) : (
                orderedRules.map((rule) => (
                  <OptimizationRuleRow
                    key={rule.id}
                    rule={rule}
                    isEditing={editingRuleId === rule.id}
                    onEdit={() => setEditingRuleId(rule.id)}
                    onSave={(data) => handleUpdateRule(rule.id, data)}
                    onCancel={handleCancelEdit}
                    onDelete={() => handleDeleteRule(rule.id)}
                    onToggleEnabled={(enabled) =>
                      handleToggleEnabled(rule.id, enabled)
                    }
                    tokenPrices={tokenPrices}
                  />
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
