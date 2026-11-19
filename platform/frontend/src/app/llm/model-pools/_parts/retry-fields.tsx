"use client";

import { DocsPage } from "@archestra/shared";
import {
  MODEL_POOL_RETRY_DEFAULTS,
  MODEL_POOL_RETRY_LIMITS,
  type ModelPoolRetrySettings,
} from "@archestra/shared/model-pool-retries";
import { ChevronRight } from "lucide-react";
import { useWatch } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { FieldDescription } from "@/components/ui/field-description";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { cn } from "@/lib/utils/tailwind";
import { HelpTip } from "./pool-fields";
import {
  getRetryValue,
  type PoolForm,
  type PoolOptions,
  type RetryKey,
  withRetryValue,
} from "./pool-form";

const ERROR_TYPES = [
  ["connectionError", "Connection errors"],
  ["timeoutError", "Timeouts"],
  ["rateLimitError", "Rate limits (429)"],
  ["internalServerError", "Server errors (5xx)"],
] as const;

const LIMITS: Record<RetryKey, { min: number; max: number }> = {
  ...MODEL_POOL_RETRY_LIMITS,
  connectionError: MODEL_POOL_RETRY_LIMITS.numRetries,
  timeoutError: MODEL_POOL_RETRY_LIMITS.numRetries,
  rateLimitError: MODEL_POOL_RETRY_LIMITS.numRetries,
  internalServerError: MODEL_POOL_RETRY_LIMITS.numRetries,
};

/**
 * The pool's retries. Always on: a blank field uses the default the
 * placeholder shows, and 0 retries turns retrying within an order off.
 */
export function RetryFields({
  form,
  disabled,
}: {
  form: PoolForm;
  disabled: boolean;
}) {
  const settings = useWatch({ control: form.control, name: "retrySettings" });
  const setValue = (key: RetryKey, value: number | undefined) =>
    form.setValue("retrySettings", withRetryValue(settings, key, value), {
      shouldDirty: true,
    });
  const retries = settings?.numRetries ?? MODEL_POOL_RETRY_DEFAULTS.numRetries;

  return (
    <div className="@container space-y-3">
      <div className="space-y-0.5">
        <Label>Retries</Label>
        <FieldDescription>
          <span>
            Try another healthy member of the same order after a temporary
            failure, before moving to the next order.
          </span>{" "}
          <ExternalDocsLink
            href={getFrontendDocsUrl(
              DocsPage.PlatformLlmProxyModelPools,
              "retries",
            )}
            showIcon={false}
            className="underline"
          >
            How retries work
          </ExternalDocsLink>
        </FieldDescription>
      </div>
      <div className="grid gap-3 @lg:grid-cols-3">
        <RetryInput
          id="pool-retry-numRetries"
          label="Retries"
          help="Extra attempts within an order, shared by its members. 0 moves straight to the next order."
          settingKey="numRetries"
          value={settings?.numRetries}
          placeholder={String(MODEL_POOL_RETRY_DEFAULTS.numRetries)}
          disabled={disabled}
          onChange={(value) => setValue("numRetries", value)}
        />
        <RetryInput
          id="pool-retry-initialDelayMs"
          label="Initial delay"
          help="Wait before the first retry. It doubles on each retry."
          settingKey="initialDelayMs"
          value={settings?.initialDelayMs}
          placeholder={String(MODEL_POOL_RETRY_DEFAULTS.initialDelayMs)}
          disabled={disabled}
          onChange={(value) => setValue("initialDelayMs", value)}
        />
        <RetryInput
          id="pool-retry-maxDelayMs"
          label="Maximum delay"
          help="Longest wait between retries. A longer Retry-After moves to the next order instead."
          settingKey="maxDelayMs"
          value={settings?.maxDelayMs}
          belowInitial={isBelowInitial(settings)}
          placeholder={String(MODEL_POOL_RETRY_DEFAULTS.maxDelayMs)}
          disabled={disabled}
          onChange={(value) => setValue("maxDelayMs", value)}
        />
      </div>
      <ErrorTypeFold
        idPrefix="pool-retry"
        policy={settings?.retryPolicy}
        inherited={retries}
        disabled={disabled}
        onChange={setValue}
      />
    </div>
  );
}

/** Per-error retry counts, folded away unless one is set. */
function ErrorTypeFold({
  idPrefix,
  policy,
  inherited,
  disabled,
  onChange,
  className,
}: {
  idPrefix: string;
  policy: ModelPoolRetrySettings["retryPolicy"];
  /** What a blank count uses. */
  inherited: number;
  disabled: boolean;
  onChange: (key: RetryKey, value: number | undefined) => void;
  className?: string;
}) {
  return (
    <Collapsible
      defaultOpen={Object.keys(policy ?? {}).length > 0}
      className={className}
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="group -ml-1.5 text-muted-foreground"
        >
          <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
          <span>Retries by error type</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="grid grid-cols-2 gap-3 @lg:grid-cols-4">
          {ERROR_TYPES.map(([key, label]) => (
            <RetryInput
              key={key}
              id={`${idPrefix}-${key}`}
              label={label}
              settingKey={key}
              value={policy?.[key]}
              placeholder={String(inherited)}
              disabled={disabled}
              onChange={(value) => onChange(key, value)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const OVERRIDE_KEYS = ["numRetries", "initialDelayMs", "maxDelayMs"] as const;
const OVERRIDE_LABELS: Record<(typeof OVERRIDE_KEYS)[number], string> = {
  numRetries: "Retries",
  initialDelayMs: "Initial delay",
  maxDelayMs: "Maximum delay",
};

/**
 * Per-member retry settings, read from the same member list the Pool tab
 * edits, so removing a member there removes its override here.
 */
export function MemberRetryOverrides({
  form,
  options,
  disabled,
}: {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
}) {
  const pool = useWatch({ control: form.control, name: "retrySettings" });
  const members = useWatch({ control: form.control, name: "members" });
  if (members.length === 0) return null;
  const inherited = (key: (typeof OVERRIDE_KEYS)[number]) =>
    String(pool?.[key] ?? MODEL_POOL_RETRY_DEFAULTS[key]);

  return (
    <div className="@container space-y-3">
      <div className="space-y-0.5">
        <Label>Member overrides</Label>
        <FieldDescription>
          <span>
            Used when this member is the first to fail in its order. Blank uses
            the pool's value.
          </span>
        </FieldDescription>
      </div>
      <div className="overflow-hidden rounded-md border">
        <div className="hidden grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] gap-3 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground @xl:grid">
          <span>Member</span>
          {OVERRIDE_KEYS.map((key) => (
            <span key={key}>{OVERRIDE_LABELS[key]}</span>
          ))}
        </div>
        <ul className="divide-y">
          {members.map((member, index) => {
            const key = options.keysById.get(member.providerApiKeyId);
            // setValue, not a Controller: a registered field per row would
            // outlive a removed member and shift onto the next one.
            const setValue = (
              settingKey: RetryKey,
              value: number | undefined,
            ) =>
              form.setValue(
                `members.${index}.retrySettings`,
                withRetryValue(member.retrySettings, settingKey, value),
                { shouldDirty: true },
              );
            return (
              <li
                // Members have no stable id before save; the index matches
                // the form path each input writes to.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={index}
                className="grid gap-x-3 gap-y-2 px-3 py-2 @xl:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] @xl:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {key?.name ?? "Choose a provider key"}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {member.modelId || "No model"} · order {member.priority}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 @xl:contents">
                  {OVERRIDE_KEYS.map((settingKey) => (
                    <RetryInput
                      key={settingKey}
                      id={`member-${index}-retry-${settingKey}`}
                      label={OVERRIDE_LABELS[settingKey]}
                      hideLabelWide
                      settingKey={settingKey}
                      value={getRetryValue(member.retrySettings, settingKey)}
                      belowInitial={
                        settingKey === "maxDelayMs" &&
                        isBelowInitial(member.retrySettings)
                      }
                      placeholder={inherited(settingKey)}
                      disabled={disabled}
                      onChange={(value) => setValue(settingKey, value)}
                    />
                  ))}
                </div>
                <ErrorTypeFold
                  idPrefix={`member-${index}-retry`}
                  policy={member.retrySettings?.retryPolicy}
                  inherited={
                    member.retrySettings?.numRetries ??
                    pool?.numRetries ??
                    MODEL_POOL_RETRY_DEFAULTS.numRetries
                  }
                  disabled={disabled}
                  onChange={setValue}
                  className="@xl:col-span-full"
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function isBelowInitial(settings: ModelPoolRetrySettings | null | undefined) {
  return (
    settings?.initialDelayMs !== undefined &&
    settings.maxDelayMs !== undefined &&
    settings.maxDelayMs < settings.initialDelayMs
  );
}

function RetryInput({
  id,
  label,
  help,
  hideLabelWide = false,
  belowInitial = false,
  settingKey,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  /** Explains the field; the tip adds its default and range. */
  help?: string;
  /** The table header names the column on wide screens. */
  hideLabelWide?: boolean;
  /** A maximum delay below the initial delay set beside it. */
  belowInitial?: boolean;
  settingKey: RetryKey;
  value: number | undefined;
  placeholder: string;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const { min, max } = LIMITS[settingKey];
  const isDelay =
    settingKey === "initialDelayMs" || settingKey === "maxDelayMs";
  const unit = isDelay ? "ms" : "retries";
  const defaultText = isDelay ? `${placeholder} ms` : placeholder;
  const outOfRange = value !== undefined && (value < min || value > max);
  const invalid = outOfRange || belowInitial;
  return (
    <div className="min-w-0 space-y-1.5">
      <span
        className={cn(
          "flex items-center gap-1.5",
          hideLabelWide && "@xl:sr-only",
        )}
      >
        <Label
          htmlFor={id}
          className="text-xs font-normal text-muted-foreground"
        >
          {label}
        </Label>
        {help ? (
          <HelpTip topic={label}>
            <span>
              {help} Default {defaultText}. {min} to {max} {unit}.
            </span>
          </HelpTip>
        ) : null}
      </span>
      <InputGroup data-disabled={disabled}>
        <InputGroupInput
          id={id}
          inputMode="numeric"
          value={value ?? ""}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid}
          title={
            outOfRange
              ? `Use ${min} to ${max}`
              : belowInitial
                ? "Use at least the initial delay"
                : undefined
          }
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "");
            onChange(digits === "" ? undefined : Number(digits));
          }}
          className="tabular-nums"
        />
        {isDelay ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>ms</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  );
}
