/** The component to display an editable optimization rule */

import { type SupportedProvider, SupportedProviders } from "@shared";
import { AlertCircle, Plus } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useState } from "react";
import { Condition } from "@/app/cost/optimization-rules/_parts/condition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const providerDictionary: Record<SupportedProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

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
        {providerDictionary[provider]}
      </Badge>
    );
  }

  return (
    <Select value={provider} onValueChange={onChange}>
      <SelectTrigger size="sm" className="!h-7">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {providers.map((providerItem) => {
          return (
            <SelectItem key={providerItem} value={providerItem}>
              {providerDictionary[providerItem]}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

// Model Selector Component
function ModelSelect({
  model,
  provider,
  models,
  onChange,
  editable,
}: {
  model: string;
  provider: SupportedProvider;
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
          No pricing configured for {providerDictionary[provider]} models.
        </span>{" "}
        <Link
          href="/cost/token-price"
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
                    href="/cost/token-price"
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
    <Select value={model || undefined} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        className="max-w-36 bg-green-100 border-green-200 !h-7"
      >
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
    <div className="flex flex-row gap-2 whitespace-nowrap">
      <Select
        value={entityType}
        onValueChange={(value) => {
          if (value === "organization" || value === "team") {
            onChange(value, undefined);
          }
        }}
      >
        <SelectTrigger size="sm" className="!h-7">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="organization">organization</SelectItem>
          <SelectItem value="team">team</SelectItem>
        </SelectContent>
      </Select>
      {entityType === "team" && (
        <Select
          value={entityId || undefined}
          onValueChange={(value) => onChange(entityType, value)}
        >
          <SelectTrigger size="sm" className="!h-7">
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

function AddCondition({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClick}
            disabled={disabled}
            className="text-primary hover:text-primary h-9 w-10"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Add condition</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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

  const onAddCondition = (e: React.MouseEvent) => {
    e.preventDefault();

    // Check what condition types already exist
    const hasContentLength = formData.conditions.some((c) => "maxLength" in c);
    const hasToolPresence = formData.conditions.some((c) => "hasTools" in c);

    // Determine which type to add based on what's missing
    let newCondition: Conditions[number];
    if (!hasContentLength) {
      newCondition = { maxLength: 1000 };
    } else if (!hasToolPresence) {
      newCondition = { hasTools: false };
    } else {
      // Both types already exist, don't add anything
      return;
    }

    updateFormData({
      conditions: [...formData.conditions, newCondition],
    });
  };

  // Check if we can add more conditions (max 2: one of each type)
  const canAddCondition = formData.conditions.length < 2;

  const models = sortModelsByPrice(
    tokenPrices.filter((price) => price.provider === formData.provider),
  );

  return (
    <div className={cn(className, "flex flex-row gap-2 items-center text-sm")}>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={switchDisabled}
        className="mr-4"
      />
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
        provider={formData.provider}
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
        {editable && formData.conditions.length < 2 && (
          <AddCondition disabled={!canAddCondition} onClick={onAddCondition} />
        )}
      </div>
    </div>
  );
}
