"use client";

import {
  SESSION_MAX_AGE_MAX_SECONDS,
  SESSION_MAX_AGE_MIN_SECONDS,
} from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import { SettingsBlock } from "@/components/settings/settings-block";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AuthSettingsFormValues,
  CUSTOM_LIFETIME_VALUE,
  NO_SESSION_LIMIT_VALUE,
  SESSION_LIFETIME_PRESETS,
} from "./auth-settings-form";

/**
 * Absolute cap on session age, measured from sign-in. Distinct from the
 * built-in sliding expiry, which renews on activity and so never signs an
 * active user out — this cap does, once the session is older than the limit.
 *
 * Registered into the auth page's shared form; the page owns dirty tracking,
 * saving, and the floating save bar.
 */
export function SessionLifetimeSection({
  form,
}: {
  form: UseFormReturn<AuthSettingsFormValues>;
}) {
  const lifetimePreset = form.watch("sessionLifetimePreset");
  const isCustomLifetime = lifetimePreset === CUSTOM_LIFETIME_VALUE;

  return (
    <SettingsBlock
      title="Maximum session lifetime"
      description="Sign members out once their session is older than this, no matter how active they are. Sessions otherwise renew on activity indefinitely."
      control={
        <div className="flex w-80 flex-col gap-3">
          <FormField
            control={form.control}
            name="sessionLifetimePreset"
            render={({ field }) => (
              <FormItem>
                <Select
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    if (
                      value !== CUSTOM_LIFETIME_VALUE &&
                      value !== NO_SESSION_LIMIT_VALUE
                    ) {
                      form.setValue(
                        "sessionCustomLifetimeSeconds",
                        Number(value),
                        { shouldDirty: true, shouldValidate: true },
                      );
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger
                      aria-label="Maximum session lifetime"
                      className="w-full"
                    >
                      <SelectValue placeholder="Select session lifetime" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_SESSION_LIMIT_VALUE}>
                      No limit
                    </SelectItem>
                    {SESSION_LIFETIME_PRESETS.map((preset) => (
                      <SelectItem
                        key={preset.value}
                        value={String(preset.value)}
                      >
                        {preset.label}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_LIFETIME_VALUE}>
                      Custom lifetime
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />

          {isCustomLifetime ? (
            <FormField
              control={form.control}
              name="sessionCustomLifetimeSeconds"
              rules={{
                required: "Session lifetime is required",
                min: {
                  value: SESSION_MAX_AGE_MIN_SECONDS,
                  message: `Session lifetime must be at least ${SESSION_MAX_AGE_MIN_SECONDS} seconds`,
                },
                max: {
                  value: SESSION_MAX_AGE_MAX_SECONDS,
                  message: `Session lifetime must be at most ${SESSION_MAX_AGE_MAX_SECONDS} seconds`,
                },
                validate: (value) =>
                  Number.isInteger(value) ||
                  "Session lifetime must be a whole number of seconds",
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Custom lifetime in seconds</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      min={SESSION_MAX_AGE_MIN_SECONDS}
                      max={SESSION_MAX_AGE_MAX_SECONDS}
                      step={1}
                      value={field.value}
                      onChange={(event) =>
                        field.onChange(Number(event.target.value))
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    Members are signed out this many seconds after sign-in.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
        </div>
      }
    />
  );
}
