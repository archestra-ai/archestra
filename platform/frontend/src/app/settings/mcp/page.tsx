"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
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
  useOrganization,
  useUpdateMcpSettings,
} from "@/lib/organization.query";

const MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS = 300;
const MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 31_536_000;
const DEFAULT_MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS = 31_536_000;

const MCP_LIFETIME_PRESETS = [
  { label: "1 hour", value: 3_600 },
  { label: "7 days", value: 604_800 },
  { label: "30 days", value: 2_592_000 },
  { label: "1 year", value: DEFAULT_MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS },
] as const;

type McpSettingsFormValues = {
  mcpOauthAccessTokenLifetimeSeconds: number;
};

export default function McpSettingsPage() {
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const updateMcpSettingsMutation = useUpdateMcpSettings(
    "MCP settings updated",
    "Failed to update MCP settings",
  );
  const form = useForm<McpSettingsFormValues>({
    defaultValues: {
      mcpOauthAccessTokenLifetimeSeconds:
        DEFAULT_MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS,
    },
    mode: "onChange",
  });

  useEffect(() => {
    if (!organization) {
      return;
    }

    form.reset({
      mcpOauthAccessTokenLifetimeSeconds:
        organization.mcpOauthAccessTokenLifetimeSeconds,
    });
  }, [form, organization]);

  const serverValue =
    organization?.mcpOauthAccessTokenLifetimeSeconds ??
    DEFAULT_MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS;
  const currentValue =
    form.watch("mcpOauthAccessTokenLifetimeSeconds") ?? serverValue;
  const hasChanges = !isOrganizationPending && currentValue !== serverValue;

  async function handleSave(values: McpSettingsFormValues) {
    const updatedOrganization = await updateMcpSettingsMutation.mutateAsync({
      mcpOauthAccessTokenLifetimeSeconds:
        values.mcpOauthAccessTokenLifetimeSeconds,
    });

    if (!updatedOrganization) {
      return;
    }

    form.reset({
      mcpOauthAccessTokenLifetimeSeconds:
        updatedOrganization.mcpOauthAccessTokenLifetimeSeconds,
    });
  }

  function handleCancel() {
    form.reset({
      mcpOauthAccessTokenLifetimeSeconds: serverValue,
    });
  }

  return (
    <SettingsSectionStack>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSave)}
          className="space-y-5"
          noValidate
        >
          <SettingsBlock
            title="OAuth token lifetime"
            description="Set how long Archestra-issued MCP OAuth access tokens remain valid for OAuth 2.1 and ID-JAG flows."
            control={
              <div className="text-sm text-muted-foreground">
                Current default: {formatLifetime(serverValue)}
              </div>
            }
          >
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="mcpOauthAccessTokenLifetimeSeconds"
                rules={{
                  required: "Token lifetime is required",
                  min: {
                    value: MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS,
                    message: `Token lifetime must be at least ${MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS} seconds`,
                  },
                  max: {
                    value: MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
                    message: `Token lifetime must be at most ${MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS} seconds`,
                  },
                  validate: (value) =>
                    Number.isInteger(value) ||
                    "Token lifetime must be a whole number of seconds",
                }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Token lifetime in seconds</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min={MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS}
                        max={MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS}
                        step={1}
                        value={field.value}
                        onChange={(event) =>
                          field.onChange(Number(event.target.value))
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      Use a value between{" "}
                      {MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS} seconds and{" "}
                      {MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS} seconds (1
                      year). This value is returned to MCP clients as{" "}
                      <code>expires_in</code>.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex flex-wrap gap-2">
                {MCP_LIFETIME_PRESETS.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      form.setValue(
                        "mcpOauthAccessTokenLifetimeSeconds",
                        preset.value,
                        {
                          shouldDirty: true,
                          shouldValidate: true,
                        },
                      );
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>

              <div className="text-sm text-muted-foreground">
                Selected lifetime: {formatLifetime(currentValue)}
              </div>
            </div>
          </SettingsBlock>

          <SettingsSaveBar
            hasChanges={hasChanges}
            isSaving={updateMcpSettingsMutation.isPending}
            permissions={{ organizationSettings: ["update"] }}
            onSave={form.handleSubmit(handleSave)}
            onCancel={handleCancel}
            disabledSave={!form.formState.isValid}
          />
        </form>
      </Form>
    </SettingsSectionStack>
  );
}

function formatLifetime(value: number): string {
  if (value >= 86_400 && value % 86_400 === 0) {
    const days = value / 86_400;
    if (days === 365) {
      return "1 year";
    }
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  if (value >= 3_600 && value % 3_600 === 0) {
    const hours = value / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  if (value >= 60 && value % 60 === 0) {
    const minutes = value / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${value} seconds`;
}
