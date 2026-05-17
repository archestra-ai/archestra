"use client";

import {
  DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS,
  OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS,
} from "@shared";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import {
  Form,
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
import {
  useOrganization,
  useUpdateAuthSettings,
} from "@/lib/organization.query";

const CUSTOM_LIFETIME_VALUE = "custom";
const OAUTH_LIFETIME_PRESETS = [
  { label: "1 hour", value: 3_600 },
  { label: "7 days", value: 604_800 },
  { label: "30 days", value: 2_592_000 },
  { label: "1 year", value: DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS },
] as const;

type OAuthTokenLifetimeFormValues = {
  lifetimePreset: string;
  customLifetimeSeconds: number;
};

export function OAuthTokenLifetimeSection() {
  const appName = useAppName();
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const updateAuthSettingsMutation = useUpdateAuthSettings(
    "Auth settings updated",
    "Failed to update Auth settings",
  );
  const initialLifetimeSeconds = organization
    ? getServerLifetimeSeconds(organization)
    : null;
  const form = useForm<OAuthTokenLifetimeFormValues>({
    defaultValues: {
      lifetimePreset:
        initialLifetimeSeconds === null
          ? ""
          : getPresetSelectValue(initialLifetimeSeconds),
      customLifetimeSeconds:
        initialLifetimeSeconds ?? DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS,
    },
    mode: "onChange",
  });

  useEffect(() => {
    if (!organization) {
      return;
    }

    const lifetimeSeconds = getServerLifetimeSeconds(organization);
    form.reset({
      lifetimePreset: getPresetSelectValue(lifetimeSeconds),
      customLifetimeSeconds: lifetimeSeconds,
    });
  }, [form, organization]);

  const serverValue = getServerLifetimeSeconds(organization);
  const selectedPreset = form.watch("lifetimePreset") ?? "";
  const lifetimePreset =
    selectedPreset ||
    (isOrganizationPending ? "" : getPresetSelectValue(serverValue));
  const customLifetimeSeconds = form.watch("customLifetimeSeconds");
  const currentValue = getSelectedLifetimeSeconds({
    lifetimePreset,
    customLifetimeSeconds,
  });
  const isCustomLifetime = lifetimePreset === CUSTOM_LIFETIME_VALUE;
  const hasChanges =
    !isOrganizationPending &&
    Number.isFinite(currentValue) &&
    currentValue !== serverValue;

  async function handleSave(values: OAuthTokenLifetimeFormValues) {
    const lifetimeSeconds = getSelectedLifetimeSeconds(values);
    const updatedOrganization = await updateAuthSettingsMutation.mutateAsync({
      oauthAccessTokenLifetimeSeconds: lifetimeSeconds,
    });

    if (!updatedOrganization) {
      return;
    }

    const updatedLifetimeSeconds =
      updatedOrganization.oauthAccessTokenLifetimeSeconds;
    form.reset({
      lifetimePreset: getPresetSelectValue(updatedLifetimeSeconds),
      customLifetimeSeconds: updatedLifetimeSeconds,
    });
  }

  function handleCancel() {
    form.reset({
      lifetimePreset: getPresetSelectValue(serverValue),
      customLifetimeSeconds: serverValue,
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSave)}
        className="space-y-5"
        noValidate
      >
        <SettingsBlock
          title="OAuth token lifetime"
          description={`Set how long ${appName}-issued user OAuth access tokens remain valid.`}
          control={
            <div className="flex w-80 flex-col gap-3">
              <FormField
                control={form.control}
                name="lifetimePreset"
                render={({ field }) => (
                  <FormItem>
                    <Select
                      value={
                        field.value ||
                        (isOrganizationPending
                          ? ""
                          : getPresetSelectValue(serverValue))
                      }
                      onValueChange={(value) => {
                        field.onChange(value);

                        if (value !== CUSTOM_LIFETIME_VALUE) {
                          form.setValue(
                            "customLifetimeSeconds",
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
                  name="customLifetimeSeconds"
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

        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateAuthSettingsMutation.isPending}
          permissions={{ organizationSettings: ["update"] }}
          onSave={form.handleSubmit(handleSave)}
          onCancel={handleCancel}
          disabledSave={!form.formState.isValid || !currentValue}
        />
      </form>
    </Form>
  );
}

function getServerLifetimeSeconds(
  organization:
    | { oauthAccessTokenLifetimeSeconds?: number | null }
    | null
    | undefined,
): number {
  return (
    organization?.oauthAccessTokenLifetimeSeconds ??
    DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS
  );
}

function getPresetSelectValue(lifetimeSeconds: number): string {
  const preset = OAUTH_LIFETIME_PRESETS.find(
    (option) => option.value === lifetimeSeconds,
  );
  return preset ? String(preset.value) : CUSTOM_LIFETIME_VALUE;
}

function getSelectedLifetimeSeconds(
  values: OAuthTokenLifetimeFormValues,
): number {
  if (values.lifetimePreset === CUSTOM_LIFETIME_VALUE) {
    return (
      values.customLifetimeSeconds ??
      DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS
    );
  }

  return Number(values.lifetimePreset);
}
