"use client";

import type { SupportedProvider } from "@shared";
import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ModelPricing = Array<{
  provider: string;
  model: string;
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
}>;

export type SortDirection = "asc" | "desc";

function sortModelsByPrice(
  models: ModelPricing,
  direction: SortDirection,
): ModelPricing {
  return [...models].sort((a, b) => {
    const costA =
      parseFloat(a.pricePerMillionInput) + parseFloat(a.pricePerMillionOutput);
    const costB =
      parseFloat(b.pricePerMillionInput) + parseFloat(b.pricePerMillionOutput);
    return direction === "asc" ? costA - costB : costB - costA;
  });
}

type SharedProps = {
  models: ModelPricing;
  editable?: boolean;
  autoSelectFirst?: boolean;
  sortDirection?: SortDirection;
  includeAllOption?: boolean;
};

type SingleSelectProps = SharedProps & {
  multiple?: false;
  value: string;
  onValueChange: (model: string) => void;
};

type MultiSelectProps = SharedProps & {
  multiple: true;
  value: string[];
  onValueChange: (models: string[]) => void;
  maxSelected?: number;
  maxBadgeDisplay?: number;
};

export type LlmModelPickerProps = SingleSelectProps | MultiSelectProps;

export function LlmModelPicker(props: LlmModelPickerProps) {
  const { models, editable, autoSelectFirst, sortDirection, includeAllOption } =
    props;

  const sortedModels = sortDirection
    ? sortModelsByPrice(models, sortDirection)
    : models;

  const isSingle = !props.multiple;
  const value = isSingle ? props.value : props.value;

  const isAvailable = isSingle
    ? sortedModels.some((m) => m.model === value)
    : (value as string[]).every((v) => sortedModels.some((m) => m.model === v));

  useEffect(() => {
    if (autoSelectFirst && isSingle && !value && sortedModels.length > 0) {
      props.onValueChange(sortedModels[0].model);
    }
  }, [sortedModels, value, autoSelectFirst, isSingle, props]);

  if (sortedModels.length === 0) {
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

  const modelsWithCurrent = isSingle
    ? !isAvailable && value
      ? [
          {
            provider: "openai",
            model: value as string,
            pricePerMillionInput: "0",
            pricePerMillionOutput: "0",
          },
          ...sortedModels,
        ]
      : sortedModels
    : sortedModels;

  const options = modelsWithCurrent.map((price) => ({
    value: price.model,
    model: price.model,
    provider: price.provider as SupportedProvider,
    pricePerMillionInput: price.pricePerMillionInput,
    pricePerMillionOutput: price.pricePerMillionOutput,
  }));

  if (!editable) {
    if (isSingle) {
      const modelPricing = modelsWithCurrent.find((m) => m.model === value);
      const hasPricing =
        modelPricing &&
        (modelPricing.pricePerMillionInput !== "0" ||
          modelPricing.pricePerMillionOutput !== "0");

      return (
        <div className="flex items-center gap-1">
          <Badge
            variant="outline"
            className={cn(
              "text-sm",
              !hasPricing && "bg-orange-100 border-orange-300",
            )}
          >
            {value as string}
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
                      href="/llm/model-providers/models"
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
      <div className="flex flex-wrap items-center gap-1">
        {(value as string[]).map((v) => {
          const modelPricing = modelsWithCurrent.find((m) => m.model === v);
          const hasPricing =
            modelPricing &&
            (modelPricing.pricePerMillionInput !== "0" ||
              modelPricing.pricePerMillionOutput !== "0");

          return (
            <div key={v} className="flex items-center gap-1">
              <Badge
                variant="outline"
                className={cn(
                  "text-sm",
                  !hasPricing && "bg-orange-100 border-orange-300",
                )}
              >
                {v}
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
        })}
      </div>
    );
  }

  if (isSingle) {
    return (
      <LlmModelSearchableSelect
        value={value as string}
        onValueChange={props.onValueChange}
        options={options}
        placeholder="Select target model..."
        className="w-full"
        showPricing
      />
    );
  }

  const handleMultiValueChange = (values: string[]) => {
    if (!includeAllOption) {
      props.onValueChange(values);
      return;
    }

    const hasAll = values.includes("all");
    const hadAll = (value as string[]).includes("all");

    if (hasAll && !hadAll) {
      props.onValueChange(["all"]);
      return;
    }

    if (hadAll && values.length > 1) {
      props.onValueChange(values.filter((v) => v !== "all"));
      return;
    }

    props.onValueChange(values);
  };

  return (
    <LlmModelSearchableSelect
      multiple
      value={value as string[]}
      onValueChange={handleMultiValueChange}
      options={options}
      placeholder="Select target models..."
      className="w-full"
      showPricing
      maxSelected={props.maxSelected}
      maxBadgeDisplay={props.maxBadgeDisplay}
      includeAllOption={includeAllOption}
    />
  );
}
