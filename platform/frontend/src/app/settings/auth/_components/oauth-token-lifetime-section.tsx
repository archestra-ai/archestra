"use client";

import {
  OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS,
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import {
  type AuthSettingsFormValues,
  CUSTOM_LIFETIME_VALUE,
  getOauthPresetSelectValue,
  getServerOauthLifetimeSeconds,
  OAUTH_LIFETIME_PRESETS,
} from "./auth-settings-form";

/**
 * OAuth token lifetime controls, registered into the auth page's shared form.
 * The page owns dirty tracking, saving, and the floating save bar.
 */
export function OAuthTokenLifetimeSection({
  form,
}: {
  form: UseFormReturn<AuthSettingsFormValues>;
}) {
  const appName = useAppName();
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const serverValue = getServerOauthLifetimeSeconds(organization);
  const selectedPreset = form.watch("oauthLifetimePreset") ?? "";
  const lifetimePreset =
    selectedPreset ||
    (isOrganizationPending ? "" : getOauthPresetSelectValue(serverValue));
  const isCustomLifetime = lifetimePreset === CUSTOM_LIFETIME_VALUE;

  return (
    <SettingsBlock
      title="OAuth token lifetime"
      description={`Set how long ${appName}-issued user OAuth access tokens remain valid.`}
      control={
        <div className="flex w-80 flex-col gap-3">
          <FormField
            control={form.control}
            name="oauthLifetimePreset"
            render={({ field }) => (
              <FormItem>
                <Select
                  value={
                    field.value ||
                    (isOrganizationPending
                      ? ""
                      : getOauthPresetSelectValue(serverValue))
                  }
                  onValueChange={(value) => {
                    field.onChange(value);

                    if (value !== CUSTOM_LIFETIME_VALUE) {
                      form.setValue(
                        "oauthCustomLifetimeSeconds",
                        Number(value),
                        {
                          shouldDirty: true,
                          shouldValidate: true,
                        },
                      );
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger
                      aria-label="Token lifetime"
                      className="w-full"
                    >
                      <SelectValue placeholder="Select token lifetime" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {OAUTH_LIFETIME_PRESETS.map((preset) => (
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

          {isCustomLifetime && (
            <FormField
              control={form.control}
              name="oauthCustomLifetimeSeconds"
              rules={{
                required: "Token lifetime is required",
                min: {
                  value: OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS,
                  message: `Token lifetime must be at least ${OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS} seconds`,
                },
                max: {
                  value: OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
                  message: `Token lifetime must be at most ${OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS} seconds`,
                },
                validate: (value) =>
                  Number.isInteger(value) ||
                  "Token lifetime must be a whole number of seconds",
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Custom lifetime in seconds</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      min={OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS}
                      max={OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS}
                      step={1}
                      value={field.value}
                      onChange={(event) =>
                        field.onChange(Number(event.target.value))
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    This value is returned in OAuth token responses as{" "}
                    <code>expires_in</code>.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
      }
    />
  );
}
