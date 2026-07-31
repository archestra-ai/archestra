"use client";

import {
  DEFAULT_SOFT_DELETE_RETENTION_DAYS,
  SOFT_DELETE_RETENTION_MAX_DAYS,
  SOFT_DELETE_RETENTION_MIN_DAYS,
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateDeletedItemsSettings,
} from "@/lib/organization.query";

type RetentionFormValues = {
  retentionDays: number;
  autoPurgeEnabled: boolean;
};

export function RetentionSection() {
  const { data: organization, isPending } = useOrganization();
  const updateSettings = useUpdateDeletedItemsSettings(
    "Retention settings updated",
    "Failed to update retention settings",
  );

  const serverValues = getServerValues(organization);
  const form = useForm<RetentionFormValues>({
    defaultValues: serverValues,
    mode: "onChange",
  });

  useEffect(() => {
    if (!organization) return;
    form.reset(getServerValues(organization));
  }, [form, organization]);

  const retentionDays = form.watch("retentionDays");
  const autoPurgeEnabled = form.watch("autoPurgeEnabled");
  const hasChanges =
    !isPending &&
    (autoPurgeEnabled !== serverValues.autoPurgeEnabled ||
      (Number.isFinite(retentionDays) &&
        retentionDays !== serverValues.retentionDays));

  async function handleSave(values: RetentionFormValues) {
    const updated = await updateSettings.mutateAsync({
      softDeleteRetentionDays: values.retentionDays,
      softDeleteAutoPurgeEnabled: values.autoPurgeEnabled,
    });
    if (!updated) return;
    form.reset(getServerValues(updated));
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSave)}
        className="space-y-5"
        noValidate
      >
        <SettingsBlock
          title="Retention"
          description="Deleted items stay here until they are cleaned up. Anyone who deletes something can get it back until then."
        >
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-1">
                <Label htmlFor="autoPurgeEnabled">
                  Clean up deleted items automatically
                </Label>
                <p className="text-sm text-muted-foreground">
                  When off, deleted items are kept indefinitely and only a
                  permanent delete below removes them.
                </p>
              </div>
              <FormField
                control={form.control}
                name="autoPurgeEnabled"
                render={({ field }) => (
                  <FormItem className="shrink-0">
                    <FormControl>
                      <Switch
                        id="autoPurgeEnabled"
                        className="mt-0.5"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            {autoPurgeEnabled && (
              <FormField
                control={form.control}
                name="retentionDays"
                rules={{
                  required: "A retention period is required",
                  min: {
                    value: SOFT_DELETE_RETENTION_MIN_DAYS,
                    message: `Keep deleted items for at least ${SOFT_DELETE_RETENTION_MIN_DAYS} day`,
                  },
                  max: {
                    value: SOFT_DELETE_RETENTION_MAX_DAYS,
                    message: `Keep deleted items for at most ${SOFT_DELETE_RETENTION_MAX_DAYS} days`,
                  },
                  validate: (value) =>
                    Number.isInteger(value) ||
                    "The retention period must be a whole number of days",
                }}
                render={({ field }) => (
                  <FormItem className="max-w-xs">
                    <FormLabel>Keep deleted items for</FormLabel>
                    <FormControl>
                      <div className="flex items-center gap-2">
                        <Input
                          {...field}
                          type="number"
                          min={SOFT_DELETE_RETENTION_MIN_DAYS}
                          max={SOFT_DELETE_RETENTION_MAX_DAYS}
                          step={1}
                          value={field.value}
                          onChange={(event) =>
                            field.onChange(Number(event.target.value))
                          }
                        />
                        <span className="text-sm text-muted-foreground">
                          days
                        </span>
                      </div>
                    </FormControl>
                    <FormDescription>
                      A daily cleanup permanently deletes anything older than
                      this, along with any files it stored. This cannot be
                      undone.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </div>
        </SettingsBlock>

        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateSettings.isPending}
          permissions={{ organizationSettings: ["update"] }}
          onSave={form.handleSubmit(handleSave)}
          onCancel={() => form.reset(serverValues)}
          disabledSave={!form.formState.isValid}
        />
      </form>
    </Form>
  );
}

function getServerValues(
  organization:
    | {
        softDeleteRetentionDays?: number | null;
        softDeleteAutoPurgeEnabled?: boolean | null;
      }
    | null
    | undefined,
): RetentionFormValues {
  return {
    retentionDays:
      organization?.softDeleteRetentionDays ??
      DEFAULT_SOFT_DELETE_RETENTION_DAYS,
    autoPurgeEnabled: organization?.softDeleteAutoPurgeEnabled ?? true,
  };
}
