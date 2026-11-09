"use client";

import {
  type ModelPoolRetrySettings,
  ModelPoolRetrySettingsSchema,
} from "@archestra/shared/model-pool-retries";
import { Controller } from "react-hook-form";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { PoolForm } from "./pool-form";

const ERROR_FIELDS = [
  ["connectionError", "Connection errors"],
  ["timeoutError", "Timeouts"],
  ["rateLimitError", "Rate limits (429)"],
  ["internalServerError", "Server errors (5xx)"],
] as const;

/** Optional settings leave existing pools unchanged and let members inherit. */
export function RetryFields({
  form,
  disabled,
  memberIndex,
}: {
  form: PoolForm;
  disabled: boolean;
  memberIndex?: number;
}) {
  const name =
    memberIndex === undefined
      ? "retrySettings"
      : (`members.${memberIndex}.retrySettings` as const);
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => {
        const value = field.value;
        const update = (settings: ModelPoolRetrySettings | null) =>
          field.onChange(settings);
        const valid =
          value == null ||
          ModelPoolRetrySettingsSchema.safeParse(value).success;
        return (
          <div className="space-y-3">
            <Label className="flex items-center gap-2 text-sm">
              <Switch
                disabled={disabled}
                checked={value != null}
                onCheckedChange={(checked) => update(checked ? {} : null)}
              />
              <span>
                {memberIndex === undefined
                  ? "Configure retries"
                  : "Override retries for this member"}
              </span>
            </Label>
            {value != null ? (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">
                  Additional attempts after a failure, before failover. Zero
                  disables retries for that setting; error overrides take
                  priority. Blank fields use{" "}
                  {memberIndex === undefined ? "defaults" : "the pool settings"}
                  . The initial delay is capped at the effective maximum after
                  inheritance. Responses already streaming are never retried.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <RetryNumber
                    label="Default retries"
                    value={value.numRetries}
                    placeholder={memberIndex === undefined ? "2" : "Inherit"}
                    max={10}
                    disabled={disabled}
                    onChange={(numRetries) => update({ ...value, numRetries })}
                  />
                  {ERROR_FIELDS.map(([key, label]) => (
                    <RetryNumber
                      key={key}
                      label={label}
                      value={value.retryPolicy?.[key]}
                      placeholder={
                        memberIndex === undefined
                          ? "Default retries"
                          : "Inherit pool override/default"
                      }
                      max={10}
                      disabled={disabled}
                      onChange={(count) =>
                        update({
                          ...value,
                          retryPolicy: { ...value.retryPolicy, [key]: count },
                        })
                      }
                    />
                  ))}
                  <RetryNumber
                    label="Initial delay (ms)"
                    value={value.initialDelayMs}
                    placeholder={memberIndex === undefined ? "500" : "Inherit"}
                    min={100}
                    max={8000}
                    disabled={disabled}
                    onChange={(initialDelayMs) =>
                      update({ ...value, initialDelayMs })
                    }
                  />
                  <RetryNumber
                    label="Maximum delay (ms)"
                    value={value.maxDelayMs}
                    placeholder={memberIndex === undefined ? "8000" : "Inherit"}
                    min={100}
                    max={60000}
                    disabled={disabled}
                    onChange={(maxDelayMs) => update({ ...value, maxDelayMs })}
                  />
                </div>
                {!valid && (
                  <InlineNotice variant="error">
                    <InlineNoticeText>
                      Use whole retry counts from 0 to 10, an initial delay from
                      100 to 8000 ms, and a maximum delay from 100 to 60000 ms
                      that is at least the initial delay.
                    </InlineNoticeText>
                  </InlineNotice>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {memberIndex === undefined
                  ? "Keep existing retry and failover behavior."
                  : "Inherit the pool’s retry behavior."}
              </p>
            )}
          </div>
        );
      }}
    />
  );
}

function RetryNumber({
  label,
  value,
  placeholder,
  min = 0,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number | undefined;
  placeholder: string;
  min?: number;
  max: number;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Label className="grid gap-1.5 text-xs font-normal">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
      />
    </Label>
  );
}
