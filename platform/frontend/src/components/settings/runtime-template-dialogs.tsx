"use client";

import {
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  type archestraApiTypes,
  buildAgentCatalogRuntime,
  withAgentRuntimeDefaults,
} from "@archestra/shared";
import {
  BadgeCheck,
  Box,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useId, useState } from "react";
import { useController, useForm, useWatch } from "react-hook-form";
import { AgentIcon } from "@/components/agent-icon";
import { CatalogAgentIcon } from "@/components/agent-pages/agent-catalog";
import {
  type AgentRuntimeConfig,
  AgentRuntimeEnvironmentFields,
  AgentRuntimeImageFields,
  AgentRuntimeLimitFields,
  AgentRuntimeProtocolField,
  AgentRuntimeSteeringField,
  agentRuntimeSectionDescriptions,
  defaultAgentRuntime,
} from "@/components/agent-runtime-fields";
import { IdentityFields } from "@/components/identity-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  useAgentsBehindRuntime,
  useApplyAgentRuntimeToAgents,
} from "@/lib/agent-runtime-templates.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

type SaveBody = archestraApiTypes.SaveRuntimeTemplateSettingsData["body"];
export type TemplateDraft = SaveBody["templates"][number];
export type BuiltInRuntime = NonNullable<
  NonNullable<SaveBody["builtIns"]>[AgentCatalogId]
>;
type Section = "general" | "runtime";

// ===================================================================
// Custom runtime
// ===================================================================

/** Adds a custom runtime, or edits `template`. */
export function CustomRuntimeDialog({
  template,
  names,
  savedScope,
  isSaving,
  onClose,
  onSave,
}: {
  /** Null when adding a new custom runtime. */
  template: TemplateDraft | null;
  /** The other runtimes' names, which this one's must differ from. */
  names: string[];
  /** Its permission scope once saved; until then it has no permissions. */
  savedScope: string | null;
  /** The runtime list is being saved. */
  isSaving: boolean;
  onClose: () => void;
  onSave: (template: TemplateDraft) => void;
}) {
  const appName = useAppName();
  const [section, setSection] = useState<Section>("general");
  const form = useForm<TemplateDraft>({
    defaultValues: template ?? {
      id: crypto.randomUUID(),
      name: "",
      description: "",
      icon: null,
      hidden: false,
      position: 0,
      runtime: { ...defaultAgentRuntime(), privileged: false },
    },
  });
  const { field: runtimeField, fieldState: runtimeState } = useController({
    control: form.control,
    name: "runtime",
    rules: {
      validate: (value) =>
        !value.image.trim()
          ? "Enter a container image"
          : /\s/.test(value.image.trim())
            ? "Container images cannot contain whitespace"
            : true,
    },
  });
  const runtime = runtimeField.value;
  const setRuntime = runtimeField.onChange;
  const name = useWatch({ control: form.control, name: "name" });
  const icon = useWatch({ control: form.control, name: "icon" });
  const isDirty = form.formState.isDirty;
  const title = template ? `Edit ${template.name}` : "Add custom runtime";

  return (
    <TabbedDialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description="Defaults for new agents that use this runtime."
      headerExtra={<RuntimeKindLabel builtIn={false} />}
      sidebarLabel={name?.trim() || "New runtime"}
      sidebarDescription="Custom runtime"
      sidebarIcon={
        icon ? (
          <AgentIcon icon={icon} size={16} />
        ) : (
          <Box className="size-4 text-muted-foreground" />
        )
      }
      isDirty={isDirty}
      activeSection={section}
      onActiveSectionChange={setSection}
      navItems={[
        {
          id: "general",
          label: "General",
          status: savedScope ? "Name and access" : "Name",
        },
        {
          id: "runtime",
          label: "Runtime settings",
          status: runtimeState.error
            ? "Needs an image"
            : containerSummary(runtime),
        },
      ]}
      wrapForm={(children) => <Form {...form}>{children}</Form>}
      onSubmit={(event) =>
        void form.handleSubmit(onSave, (errors) => {
          if (errors.name) setSection("general");
          else if (errors.runtime) setSection("runtime");
        })(event)
      }
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={isSaving}>
            <span>{template ? "Save runtime" : "Add runtime"}</span>
          </Button>
        </>
      }
    >
      <div hidden={section !== "general"}>
        <SettingsSectionGroup>
          <SettingsSection
            title="Details"
            description="How people find this runtime when they create an agent."
          >
            <FormField
              control={form.control}
              name="icon"
              render={({ field: iconField }) => (
                <FormField
                  control={form.control}
                  name="name"
                  rules={{
                    required: "Enter a name",
                    maxLength: {
                      value: 100,
                      message: "Use at most 100 characters",
                    },
                    validate: (value) =>
                      !value.trim()
                        ? "Enter a name"
                        : names.some(
                              (other) =>
                                other.toLocaleLowerCase() ===
                                value.trim().toLocaleLowerCase(),
                            )
                          ? "Choose a unique runtime name"
                          : true,
                  }}
                  render={({ field }) => (
                    <FormItem>
                      <IdentityFields
                        icon={iconField.value}
                        onIconChange={iconField.onChange}
                        label={<FormLabel>Name</FormLabel>}
                      >
                        <FormControl>
                          <Input
                            {...field}
                            maxLength={100}
                            placeholder="Engineering workspace"
                          />
                        </FormControl>
                        <FormMessage />
                      </IdentityFields>
                    </FormItem>
                  )}
                />
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      rows={2}
                      maxLength={1_000}
                      className="min-h-0 resize-none"
                      placeholder="What should people use this runtime for?"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsSection>
          <AccessSection scope={savedScope} />
        </SettingsSectionGroup>
      </div>

      <div hidden={section !== "runtime"}>
        <SettingsSectionGroup>
          <SettingsSection
            title="Container"
            description="The image each run starts from."
          >
            <AgentRuntimeImageFields
              value={runtime}
              onChange={(value) => setRuntime({ ...value, privileged: false })}
            />
            {runtimeState.error?.message && (
              <p className="text-destructive text-sm">
                {runtimeState.error.message}
              </p>
            )}
          </SettingsSection>
          <SettingsSection
            title="Inference API"
            description={agentRuntimeSectionDescriptions(appName).inference}
          >
            <AgentRuntimeProtocolField
              value={runtime}
              onChange={setRuntime}
              hideLabel
            />
          </SettingsSection>
          <SettingsSection
            title="Follow-up messages"
            description={agentRuntimeSectionDescriptions(appName).followUps}
          >
            <AgentRuntimeSteeringField
              value={runtime}
              onChange={setRuntime}
              hideLabel
            />
          </SettingsSection>
          <SettingsSection
            title="Environment"
            description="Variables and credentials set in every run."
          >
            <AgentRuntimeEnvironmentFields
              value={runtime}
              onChange={setRuntime}
              hideLabel
              hideDescription
            />
          </SettingsSection>
          <SettingsSection
            title="Limits"
            description="Run time, spend and tiers."
          >
            <AgentRuntimeLimitFields value={runtime} onChange={setRuntime} />
          </SettingsSection>
          <ExistingAgentsSection
            runtimeId={savedScope}
            name={template?.name ?? "this runtime"}
            settings="container, inference API, follow-up messages and limits"
            blockedReason={
              savedScope === null
                ? "Once you add this runtime, you can update agents that use it."
                : isDirty
                  ? "Updates use the saved settings. Save this runtime first."
                  : null
            }
          />
        </SettingsSectionGroup>
      </div>
    </TabbedDialogShell>
  );
}

// ===================================================================
// Built-in runtime
// ===================================================================

/** Edits an administrator's settings for a maintained runtime. */
export function BuiltInRuntimeDialog({
  id,
  image,
  value,
  scope,
  isSaving,
  onClose,
  onSave,
}: {
  id: AgentCatalogId;
  /** The maintained image this runtime runs. */
  image: string;
  value: BuiltInRuntime | undefined;
  /** Its permission scope. */
  scope: string;
  /** The runtime list is being saved. */
  isSaving: boolean;
  onClose: () => void;
  onSave: (value: BuiltInRuntime) => void;
}) {
  const name = AGENT_CATALOG_NAMES[id];
  const [section, setSection] = useState<Section>("general");
  const [initial] = useState<AgentRuntimeConfig>(() =>
    withAgentRuntimeDefaults({
      runtime: buildAgentCatalogRuntime({ id, image }),
      defaults: value?.settings,
    }),
  );
  const [runtime, setRuntime] = useState<AgentRuntimeConfig>(initial);
  const isDirty = JSON.stringify(runtime) !== JSON.stringify(initial);

  const save = () =>
    onSave({
      settings: {
        tier: runtime.tier ?? null,
        maxTier: runtime.maxTier ?? null,
        ttlHours: runtime.ttlHours,
        maxCostUsd: runtime.maxCostUsd,
        idleTimeoutMinutes: runtime.idleTimeoutMinutes,
        ...(runtime.claudeCode && {
          claudeCode: {
            authentication: runtime.claudeCode.authentication,
          },
        }),
      },
    });

  return (
    <TabbedDialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Edit ${name}`}
      description={`Defaults for new ${name} agents.`}
      headerExtra={<RuntimeKindLabel builtIn />}
      sidebarLabel={name}
      sidebarDescription="Built-in runtime"
      sidebarIcon={<CatalogAgentIcon id={id} size={16} />}
      isDirty={isDirty}
      activeSection={section}
      onActiveSectionChange={setSection}
      navItems={[
        { id: "general", label: "General", status: "Name and access" },
        {
          id: "runtime",
          label: "Runtime settings",
          status: containerSummary(runtime),
        },
      ]}
      onSubmit={save}
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={isSaving}>
            <span>Save runtime</span>
          </Button>
        </>
      }
    >
      <div hidden={section !== "general"}>
        <SettingsSectionGroup>
          <SettingsSection
            title="Details"
            description="Maintained runtimes keep their name and icon."
          >
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted">
                <CatalogAgentIcon id={id} size={20} />
              </div>
              <div className="min-w-0 space-y-1">
                <span className="block truncate text-sm font-medium">
                  {name}
                </span>
                <p className="text-sm text-muted-foreground">
                  Updated with each release.
                </p>
              </div>
            </div>
          </SettingsSection>
          <AccessSection scope={scope} />
        </SettingsSectionGroup>
      </div>

      <div hidden={section !== "runtime"}>
        <SettingsSectionGroup>
          <SettingsSection
            title="Container"
            description="The maintained image and client."
          >
            <div className="space-y-1.5">
              <code className="block break-all rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs">
                {image}
              </code>
              <p className="text-sm text-muted-foreground">
                Kept up to date with each release. It can't be changed.
              </p>
            </div>
          </SettingsSection>
          {runtime.claudeCode && (
            <SettingsSection
              title="Claude account"
              description="Whose account runs the model."
            >
              <ClaudeAccountField
                value={runtime.claudeCode.authentication}
                onChange={(authentication) =>
                  setRuntime({
                    ...runtime,
                    claudeCode: { ...runtime.claudeCode, authentication },
                  })
                }
              />
            </SettingsSection>
          )}
          <SettingsSection
            title="Limits"
            description="Run time, spend and tiers."
          >
            <AgentRuntimeLimitFields value={runtime} onChange={setRuntime} />
          </SettingsSection>
          <ExistingAgentsSection
            runtimeId={id}
            name={name}
            settings={
              runtime.claudeCode ? "Claude account and limits" : "limits"
            }
            blockedReason={
              isDirty
                ? "Updates use the saved settings. Save this runtime first."
                : null
            }
          />
        </SettingsSectionGroup>
      </div>
    </TabbedDialogShell>
  );
}

// ===================================================================
// Shared sections
// ===================================================================

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
function AccessSection({ scope }: { scope: string | null }) {
  return (
    <SettingsSection
      title="Access"
      description={
        <>
          <Permission>agentRuntime:use</Permission> starts agents on it.{" "}
          <Permission>agentRuntime:configure</Permission> changes its settings.
        </>
      }
    >
      {scope ? (
        <ResourceAccessSection resource="agentRuntime" id={scope} />
      ) : (
        <p className="text-sm text-muted-foreground">
          You can set permissions once the runtime is saved. Until then, only
          admins can use it.
        </p>
      )}
    </SettingsSection>
  );
}
// SPDX-SnippetEnd

/**
 * Saving a runtime only changes agents created afterwards. This brings the
 * agents created before up to date, on request.
 */
function ExistingAgentsSection({
  runtimeId,
  name,
  settings,
  blockedReason,
}: {
  runtimeId: string | null;
  name: string;
  /** The settings an update replaces, as a phrase. */
  settings: string;
  blockedReason: string | null;
}) {
  const apply = useApplyAgentRuntimeToAgents();
  const behind = useAgentsBehindRuntime(blockedReason ? null : runtimeId);
  const count = behind.data;
  const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
  return (
    <SettingsSection
      title="Existing agents"
      description="Saved changes only apply to agents created afterwards."
    >
      {blockedReason ? (
        <p className="text-sm text-muted-foreground">{blockedReason}</p>
      ) : behind.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : behind.isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't check which agents use {name}.
        </p>
      ) : count === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          Every agent on {name} already uses these settings.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {agents(count ?? 0)} on {name} still use older settings
            </p>
            <p className="text-sm text-muted-foreground">
              Updating gives them the saved {settings}. Their own environment
              variables, credentials and ports stay as they are.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!runtimeId || apply.isPending}
            onClick={() => {
              if (runtimeId) apply.mutate(runtimeId);
            }}
          >
            {apply.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            <span>Update {agents(count ?? 0)}</span>
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}

// ===================================================================
// Shared fields
// ===================================================================

function ClaudeAccountField({
  value,
  onChange,
}: {
  value: "provider" | "subscription";
  onChange: (value: "provider" | "subscription") => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="sr-only">
        Claude account
      </Label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as "provider" | "subscription")}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="subscription">
            {CLAUDE_ACCOUNT_LABELS.subscription}
          </SelectItem>
          <SelectItem value="provider">
            {CLAUDE_ACCOUNT_LABELS.provider}
          </SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription>
        Each person signs in with their own Pro or Max plan, or runs are billed
        to an LLM provider connection.
      </FieldDescription>
    </div>
  );
}

function Permission({ children }: { children: string }) {
  return (
    <code className="rounded-sm bg-muted px-1 py-px font-mono text-[0.85em]">
      {children}
    </code>
  );
}

/** Whether a runtime is one of the maintained ones or the organization's own. */
export function RuntimeKindLabel({ builtIn }: { builtIn: boolean }) {
  const Icon = builtIn ? BadgeCheck : Box;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
        builtIn
          ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
          : "bg-violet-500/10 text-violet-700 dark:text-violet-300",
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {builtIn ? "Built-in" : "Custom"}
    </span>
  );
}

function containerSummary(value: AgentRuntimeConfig): string {
  const image = value.image.trim().split("/").slice(-2).join("/");
  if (!image) return "No image set";
  return value.command?.length ? `${image}, ${value.command[0]}` : image;
}

const CLAUDE_ACCOUNT_LABELS = {
  subscription: "Each person's Claude subscription",
  provider: "A company API key",
} as const;
