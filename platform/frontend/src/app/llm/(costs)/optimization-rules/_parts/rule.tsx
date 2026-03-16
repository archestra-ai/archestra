/** The component to display an editable optimization rule */

import {
  providerDisplayNames,
  type SupportedProvider,
  SupportedProviders,
} from "@shared";
import { AlertCircle, Plus } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useState } from "react";
import { Condition } from "@/app/llm/(costs)/optimization-rules/_parts/condition";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderSelectItems } from "@/components/llm-provider-options";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { OptimizationRule } from "@/lib/optimization-rule.query";
import type { Team } from "@/lib/team.query";
import { cn } from "@/lib/utils";

type EntityType = OptimizationRule["entityType"];
type Conditions = OptimizationRule["conditions"];
type TokenPrices = Array<{
  provider: string;
  model: string;
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
}>;

// Sort models by total cost (input + output price) ascending
function sortModelsByPrice(tokenPrices: TokenPrices): TokenPrices {
  return [...tokenPrices].sort((a, b) => {
    const costA =
      parseFloat(a.pricePerMillionInput) + parseFloat(a.pricePerMillionOutput);
    const costB =
      parseFloat(b.pricePerMillionInput) + parseFloat(b.pricePerMillionOutput);
    return costA - costB;
  });
}

// Helper to get entity display name
function getEntityName(
  entityType: EntityType,
  entityId: string,
  teams: Team[],
): string {
  if (entityType === "organization") {
    return "whole organization";
  }
  const team = teams.find((t) => t.id === entityId);
  return team?.name || "unknown team";
}

export function ProviderSelect({
  provider,
  providers,
  onChange,
  editable,
}: {
  provider: SupportedProvider;
  providers: SupportedProvider[];
  onChange: (provider: SupportedProvider) => void;
  editable?: boolean;
}) {
  if (!editable) {
    return (
      <Badge variant="outline" className="text-sm">
        {providerDisplayNames[provider]}
      </Badge>
    );
  }

  return (
    <Select value={provider} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <LlmProviderSelectItems
          options={providers.map((providerItem) => ({
            value: providerItem,
            icon: `https://models.dev/logos/${providerItem}.svg`,
            name: providerDisplayNames[providerItem],
          }))}
        />
      </SelectContent>
    </Select>
  );
}

// Model Selector Component
function ModelSelect({
  model,
  models,
  onChange,
  editable,
}: {
  model: string;
  models: TokenPrices;
  onChange: (model: string) => void;
  editable?: boolean;
}) {
  // Check if current value has pricing
  const isAvailable = models.some((m) => m.model === model);

  // Auto-select first (cheapest) model if no value provided or provider changed
  useEffect(() => {
    if (!model && models.length > 0) {
      onChange(models[0].model);
    }
  }, [models, model, onChange]);

  // If no models available for this provider, show message
  if (models.length === 0) {
    return (
      <div className="px-2 text-sm">
        <span className="text-muted-foreground">
          No pricing configured for models.
        </span>{" "}
        <Link
          href="/llm/providers/models"
          className="hover:text-foreground hover:underline"
        >
          Add pricing
        </Link>
      </div>
    );
  }

  // If current value doesn't have pricing but exists, add it to the list
  const modelsWithCurrent =
    !isAvailable && model
      ? [
          {
            provider: "openai",
            model,
            pricePerMillionInput: "0",
            pricePerMillionOutput: "0",
          },
          ...models,
        ]
      : models;

  // Check if model has pricing
  const modelPricing = modelsWithCurrent.find((m) => m.model === model);
  const hasPricing =
    modelPricing &&
    (modelPricing.pricePerMillionInput !== "0" ||
      modelPricing.pricePerMillionOutput !== "0");

  if (!editable) {
    return (
      <div className="flex items-center gap-1">
        <Badge
          variant="outline"
          className={cn(
            "text-sm",
            !hasPricing && "bg-orange-100 border-orange-300",
          )}
        >
          {model}
        </Badge>
        {!hasPricing && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertCircle className="h-4 w-4 text-orange-600" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-sm">
                  No pricing configured for this model.{" "}
                  <Link
                    href="/llm/providers/models"
                    className="underline hover:text-foreground"
                  >
                    Add pricing
                  </Link>
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    );
  }

  return (
    <LlmModelSearchableSelect
      value={model}
      onValueChange={onChange}
      options={modelsWithCurrent.map((price) => ({
        value: price.model,
        model: price.model,
        provider: price.provider as SupportedProvider,
        pricePerMillionInput: price.pricePerMillionInput,
        pricePerMillionOutput: price.pricePerMillionOutput,
      }))}
      placeholder="Select target model..."
      className="w-full"
      showPricing
    />
  );
}

function EntitySelect({
  entityType,
  entityId,
  teams,
  onChange,
  editable,
}: {
  entityType: EntityType;
  entityId: string;
  teams: Team[];
  onChange: (entityType: EntityType, entityId?: string) => void;
  editable?: boolean;
}) {
  if (!editable) {
    const entityName = getEntityName(entityType, entityId, teams);
    return (
      <Badge variant="outline" className="text-sm">
        {entityName}
      </Badge>
    );
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:whitespace-nowrap">
      <Select
        value={entityType}
        onValueChange={(value) => {
          if (value === "organization" || value === "team") {
            onChange(value, undefined);
          }
        }}
      >
        <SelectTrigger className="w-full sm:flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="organization">Organization</SelectItem>
          <SelectItem value="team">Team</SelectItem>
        </SelectContent>
      </Select>
      {entityType === "team" && (
        <Select
          value={entityId || undefined}
          onValueChange={(value) => onChange(entityType, value)}
        >
          <SelectTrigger className="w-full sm:flex-1">
            <SelectValue placeholder="Select team" />
          </SelectTrigger>
          <SelectContent>
            {teams.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

type RuleProps = Omit<OptimizationRule, "createdAt" | "updatedAt"> & {
  tokenPrices: TokenPrices;
  teams?: Team[];
  editable?: boolean;
  onChange?: (
    data: Omit<OptimizationRule, "id" | "createdAt" | "updatedAt">,
  ) => void;
  onToggle?: (enabled: boolean) => void;
  switchDisabled?: boolean;
  className?: string;
};

type OptimizationRuleFormProps = Pick<
  OptimizationRule,
  | "enabled"
  | "entityType"
  | "entityId"
  | "conditions"
  | "provider"
  | "targetModel"
> & {
  tokenPrices: TokenPrices;
  teams?: Team[];
  onChange?: (
    data: Omit<OptimizationRule, "id" | "createdAt" | "updatedAt">,
  ) => void;
  onToggle?: (enabled: boolean) => void;
};

export function OptimizationRuleForm({
  enabled,
  entityType,
  entityId,
  conditions,
  provider,
  targetModel,
  tokenPrices,
  teams = [],
  onChange,
  onToggle,
}: OptimizationRuleFormProps) {
  const [formData, setFormData] = useState({
    enabled,
    entityType,
    entityId,
    conditions,
    provider,
    targetModel,
  });

  useEffect(() => {
    setFormData({
      enabled,
      entityType,
      entityId,
      conditions,
      provider,
      targetModel,
    });
  }, [enabled, entityType, entityId, conditions, provider, targetModel]);

  const updateFormData = (newData: Partial<typeof formData>) => {
    const updated = { ...formData, ...newData };
    setFormData(updated);
    onChange?.(updated);
  };

  const models = sortModelsByPrice(tokenPrices);

  const addCondition = () => {
    const hasContentLength = formData.conditions.some((c) => "maxLength" in c);
    const hasToolPresence = formData.conditions.some((c) => "hasTools" in c);

    if (!hasContentLength) {
      updateFormData({
        conditions: [...formData.conditions, { maxLength: 1000 }],
      });
      return;
    }

    if (!hasToolPresence) {
      updateFormData({
        conditions: [...formData.conditions, { hasTools: false }],
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border px-4 py-3">
        <div>
          <div className="text-sm font-medium">Rule status</div>
          <div className="text-sm text-muted-foreground">
            Enable or disable this optimization rule.
          </div>
        </div>
        <Switch checked={formData.enabled} onCheckedChange={onToggle} />
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Apply to</Label>
          <EntitySelect
            entityType={formData.entityType}
            entityId={formData.entityId}
            teams={teams}
            onChange={(nextEntityType, nextEntityId) =>
              updateFormData({
                entityType: nextEntityType,
                entityId: nextEntityId || "",
              })
            }
            editable
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Target model</Label>
        <ModelSelect
          model={formData.targetModel}
          models={models}
          onChange={(value) => {
            const selectedModel = models.find(
              (modelOption) => modelOption.model === value,
            );
            updateFormData({
              targetModel: value,
              provider:
                (selectedModel?.provider as SupportedProvider) ??
                formData.provider,
            });
          }}
          editable
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Conditions</Label>
            <div className="text-sm text-muted-foreground">
              Add up to two conditions that control when the rule applies.
            </div>
          </div>
          {formData.conditions.length < 2 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addCondition}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add condition
            </Button>
          )}
        </div>
        <div className="space-y-2">
          {formData.conditions.map((condition, index, allConditions) => (
            <Condition
              key={`${index}-${"maxLength" in condition ? "length" : "tools"}`}
              condition={condition}
              editable
              removable={allConditions.length > 1}
              onChange={(updatedCondition) => {
                const nextConditions = [...formData.conditions];
                nextConditions[index] = updatedCondition;
                updateFormData({ conditions: nextConditions });
              }}
              onRemove={() =>
                updateFormData({
                  conditions: formData.conditions.filter((_, i) => i !== index),
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Rule({
  enabled,
  entityType,
  entityId,
  conditions,
  provider,
  targetModel,
  tokenPrices,
  teams = [],
  editable,
  onChange,
  onToggle,
  switchDisabled,
  className,
}: Omit<RuleProps, "id">) {
  type FormData = {
    entityType: EntityType;
    entityId: string;
    conditions: Conditions;
    provider: SupportedProvider;
    targetModel: string;
    enabled: boolean;
  };

  const [formData, setFormData] = useState<FormData>({
    enabled,
    entityType,
    entityId,
    conditions,
    provider,
    targetModel,
  });

  // Sync formData with props when not in edit mode
  useEffect(() => {
    if (!editable) {
      setFormData({
        enabled,
        entityType,
        entityId,
        conditions,
        provider,
        targetModel,
      });
    }
  }, [
    editable,
    enabled,
    entityType,
    entityId,
    conditions,
    provider,
    targetModel,
  ]);

  // Notify parent of changes
  const updateFormData = (newData: Partial<FormData>) => {
    const updated = { ...formData, ...newData };
    setFormData(updated);
    onChange?.(updated);
  };

  const onProviderChange = (provider: SupportedProvider) =>
    updateFormData({
      provider,
      targetModel: "",
    });

  const onModelChange = (value: string) =>
    updateFormData({ targetModel: value });

  const onEntityChange = (entityType: EntityType, entityId?: string) => {
    updateFormData({
      entityType,
      entityId: entityId || "",
    });
  };

  const onConditionChange = (index: number, condition: Conditions[number]) => {
    const newConditions = [...formData.conditions];
    newConditions[index] = condition;
    updateFormData({
      conditions: newConditions,
    });
  };

  const onRemoveCondition = (index: number) => {
    if (formData.conditions.length <= 1) return; // Keep at least one condition
    const newConditions = formData.conditions.filter((_, i) => i !== index);
    updateFormData({
      conditions: newConditions,
    });
  };

  const models = sortModelsByPrice(
    tokenPrices.filter((price) => price.provider === formData.provider),
  );

  return (
    <div className={cn(className, "flex flex-row gap-2 items-center text-sm")}>
      <WithPermissions
        permissions={{ optimizationRule: ["update"] }}
        noPermissionHandle="tooltip"
      >
        {({ hasPermission }) => (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={switchDisabled || !hasPermission}
            className="mr-4"
          />
        )}
      </WithPermissions>
      In{" "}
      <EntitySelect
        entityType={formData.entityType}
        entityId={formData.entityId}
        teams={teams}
        onChange={onEntityChange}
        editable={editable}
      />
      with{" "}
      <ProviderSelect
        provider={formData.provider}
        providers={SupportedProviders}
        onChange={onProviderChange}
        editable={editable}
      />
      use{" "}
      <ModelSelect
        model={formData.targetModel}
        models={models}
        onChange={onModelChange}
        editable={editable}
      />
      if{" "}
      <div className="flex gap-2 flex-wrap items-center">
        {formData.conditions.map((condition, index, conditions) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions don't have unique IDs
          <React.Fragment key={index}>
            <Condition
              condition={condition}
              onChange={(updatedCondition) =>
                onConditionChange(index, updatedCondition)
              }
              onRemove={() => {
                onRemoveCondition(index);
              }}
              editable={editable}
              removable={conditions.length > 1}
            />
            {index < conditions.length - 1 && <span>and</span>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
