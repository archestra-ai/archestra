import {
  AGENT_RUNTIME_TIER_MAX_CPU_LIMIT,
  AGENT_RUNTIME_TIER_MAX_CPU_REQUEST,
  AGENT_RUNTIME_TIER_MIN_CPU,
} from "@archestra/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import type {
  RuntimeTierFormField,
  RuntimeTierFormValues,
} from "./runtime-tier-form";

const MEMORY_LIMIT_DEFAULT_HINT =
  "The default limit in GiB is max(2x memory request, 2x CPU request, 2x CPU limit).";
export function RuntimeTierResourceFields({
  id,
  values,
  update,
  touch,
  shown,
  defaultCpuRequest,
  defaultMemory,
}: {
  id: string;
  values: RuntimeTierFormValues;
  update: (patch: Partial<RuntimeTierFormValues>) => void;
  touch: (field: RuntimeTierFormField) => void;
  shown: (field: RuntimeTierFormField) => string | undefined;
  defaultCpuRequest: number;
  defaultMemory: { memoryRequestMiB: number; memoryLimitMiB: number } | null;
}) {
  return (
    <>
      {" "}
      <div className="grid gap-4 sm:grid-cols-2">
        <RuntimeTierField
          id={`${id}-cpu-request`}
          label="CPU request"
          error={shown("cpuRequest")}
        >
          <Input
            id={`${id}-cpu-request`}
            type="number"
            inputMode="decimal"
            min={AGENT_RUNTIME_TIER_MIN_CPU}
            max={AGENT_RUNTIME_TIER_MAX_CPU_REQUEST}
            step="any"
            placeholder={String(defaultCpuRequest)}
            value={values.cpuRequest}
            onChange={(event) => update({ cpuRequest: event.target.value })}
            onBlur={() => touch("cpuRequest")}
            aria-invalid={shown("cpuRequest") ? true : undefined}
            aria-describedby={
              shown("cpuRequest") ? `${id}-cpu-request-error` : undefined
            }
          />
        </RuntimeTierField>
        <RuntimeTierField
          id={`${id}-cpu-limit`}
          label="CPU limit"
          error={shown("cpuLimit")}
        >
          <Input
            id={`${id}-cpu-limit`}
            type="number"
            inputMode="decimal"
            min={AGENT_RUNTIME_TIER_MIN_CPU}
            max={AGENT_RUNTIME_TIER_MAX_CPU_LIMIT}
            step="any"
            placeholder="No limit"
            value={values.cpuLimit}
            onChange={(event) => update({ cpuLimit: event.target.value })}
            onBlur={() => touch("cpuLimit")}
            aria-invalid={shown("cpuLimit") ? true : undefined}
            aria-describedby={
              shown("cpuLimit") ? `${id}-cpu-limit-error` : undefined
            }
          />
        </RuntimeTierField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["memoryRequestGiB", "memoryLimitGiB"] as const).map((field) => (
          <RuntimeTierField
            key={field}
            id={`${id}-${field}`}
            label={
              field === "memoryRequestGiB"
                ? "Memory request (GiB)"
                : "Memory limit (GiB)"
            }
            error={shown(field)}
          >
            <Input
              id={`${id}-${field}`}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder={
                defaultMemory
                  ? String(
                      (field === "memoryRequestGiB"
                        ? defaultMemory.memoryRequestMiB
                        : defaultMemory.memoryLimitMiB) / 1024,
                    )
                  : undefined
              }
              value={values[field]}
              onChange={(event) => update({ [field]: event.target.value })}
              onBlur={() => touch(field)}
              aria-invalid={shown(field) ? true : undefined}
              aria-describedby={
                shown(field) ? `${id}-${field}-error` : `${id}-${field}-hint`
              }
            />
            <p
              id={`${id}-${field}-hint`}
              className="text-sm text-muted-foreground"
            >
              {field === "memoryRequestGiB" ? (
                <span>2x CPU by default</span>
              ) : (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <UnstyledButton className="cursor-help text-left underline decoration-dotted underline-offset-4">
                        2x memory request by default
                      </UnstyledButton>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {MEMORY_LIMIT_DEFAULT_HINT}
                    </TooltipContent>
                  </Tooltip>
                  <span className="sr-only"> {MEMORY_LIMIT_DEFAULT_HINT}</span>
                </>
              )}
            </p>
          </RuntimeTierField>
        ))}
      </div>
    </>
  );
}

export function RuntimeTierField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={cn(error && "text-destructive")}>
        {label}
      </Label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
