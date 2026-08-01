"use client";

import {
  SESSION_MAX_AGE_MAX_SECONDS,
  SESSION_MAX_AGE_MIN_SECONDS,
} from "@archestra/shared";
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
import {
  useOrganization,
  useUpdateAuthSettings,
} from "@/lib/organization.query";

const NO_LIMIT_VALUE = "none";
const CUSTOM_LIFETIME_VALUE = "custom";
const SESSION_LIFETIME_PRESETS = [
  { label: "8 hours", value: 28_800 },
  { label: "24 hours", value: 86_400 },
  { label: "7 days", value: 604_800 },
  { label: "30 days", value: 2_592_000 },
] as const;

type SessionLifetimeFormValues = {
  lifetimePreset: string;
  customLifetimeSeconds: number;
};

/**
 * Absolute cap on session age, measured from sign-in. Distinct from the
 * built-in sliding expiry, which renews on activity and so never signs an
 * active user out — this cap does, once the session is older than the limit.
 */
export function SessionLifetimeSection() {
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const updateAuthSettingsMutation = useUpdateAuthSettings(
    "Auth settings updated",
    "Failed to update Auth settings",
  );
  const serverValue = organization?.sessionMaxAgeSeconds ?? null;
  const form = useForm<SessionLifetimeFormValues>({
    defaultValues: {
      lifetimePreset: getPresetSelectValue(serverValue),
      customLifetimeSeconds: serverValue ?? 604_800,
    },
    mode: "onChange",
  });

  useEffect(() => {
    if (!organization) {
      return;
    }
    const value = organization.sessionMaxAgeSeconds ?? null;
    form.reset({
      lifetimePreset: getPresetSelectValue(value),
      customLifetimeSeconds: value ?? 604_800,
    });
  }, [form, organization]);

  const lifetimePreset = form.watch("lifetimePreset");
  const customLifetimeSeconds = form.watch("customLifetimeSeconds");
  const currentValue = getSelectedLifetimeSeconds({
    lifetimePreset,
    customLifetimeSeconds,
  });
  const isCustomLifetime = lifetimePreset === CUSTOM_LIFETIME_VALUE;
  const hasChanges = !isOrganizationPending && currentValue !== serverValue;

  async function handleSave(values: SessionLifetimeFormValues) {
    const sessionMaxAgeSeconds = getSelectedLifetimeSeconds(values);
    const updated = await updateAuthSettingsMutation.mutateAsync({
      sessionMaxAgeSeconds,
    });
    if (!updated) {
      return;
    }
    const value = updated.sessionMaxAgeSeconds ?? null;
    form.reset({
      lifetimePreset: getPresetSelectValue(value),
      customLifetimeSeconds: value ?? 604_800,
    });
  }

  function handleCancel() {
    form.reset({
      lifetimePreset: getPresetSelectValue(serverValue),
      customLifetimeSeconds: serverValue ?? 604_800,
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
          title="Maximum session lifetime"
          description="Sign members out once their session is older than this, no matter how active they are. Sessions otherwise renew on activity indefinitely."
          control={
            <div className="flex w-80 flex-col gap-3">
              <FormField
                control={form.control}
                name="lifetimePreset"
                render={({ field }) => (
                  <FormItem>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        if (
                          value !== CUSTOM_LIFETIME_VALUE &&
                          value !== NO_LIMIT_VALUE
                        ) {
                          form.setValue(
                            "customLifetimeSeconds",
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
                        <SelectItem value={NO_LIMIT_VALUE}>No limit</SelectItem>
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
                  name="customLifetimeSeconds"
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

        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateAuthSettingsMutation.isPending}
          permissions={{ organizationSettings: ["update"] }}
          onSave={form.handleSubmit(handleSave)}
          onCancel={handleCancel}
          disabledSave={!form.formState.isValid}
        />
      </form>
    </Form>
  );
}

function getPresetSelectValue(lifetimeSeconds: number | null): string {
  if (lifetimeSeconds === null) {
    return NO_LIMIT_VALUE;
  }
  const preset = SESSION_LIFETIME_PRESETS.find(
    (option) => option.value === lifetimeSeconds,
  );
  return preset ? String(preset.value) : CUSTOM_LIFETIME_VALUE;
}

function getSelectedLifetimeSeconds(
  values: SessionLifetimeFormValues,
): number | null {
  if (values.lifetimePreset === NO_LIMIT_VALUE) {
    return null;
  }
  if (values.lifetimePreset === CUSTOM_LIFETIME_VALUE) {
    return values.customLifetimeSeconds;
  }
  return Number(values.lifetimePreset);
}
