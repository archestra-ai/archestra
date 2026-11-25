"use client";

import {
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  agentRuntimeCanNameAccountKind,
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
import { useEffect, useRef, useState } from "react";
import { useController, useForm, useWatch } from "react-hook-form";
import type { AgentAccountLock } from "@/components/agent-account-ways-field";
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
  isClaudeCodeRuntimeConfig,
} from "@/components/agent-runtime-fields";
import { IdentityFields } from "@/components/identity-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import {
  type RuntimeAccountsChange,
  RuntimeAccountsField,
  runtimeAccountsAfter,
} from "@/components/settings/runtime-accounts-field";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  type RuntimeAccounts,
  runtimeAccountsToSave,
  useAgentsBehindRuntime,
  useApplyAgentRuntimeToAgents,
  useCountAgentsBehindRuntime,
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
  /** Saves the runtime and calls `onSaved` once it is stored. */
  onSave: (template: TemplateDraft, onSaved: () => void) => void;
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
  const title = template
    ? runtimeEditTitle(template.name)
    : "Add custom runtime";
  const claudeRuntime = isClaudeCodeRuntimeConfig(runtime);
  const accounts = useWatch({ control: form.control, name: "accounts" });
  // Whether the runtime's rule can name one kind of account: its agents
  // have two. An image that may run Claude Code has both cards before it
  // declares that it does.
  const namesKind = claudeRuntime || agentRuntimeCanNameAccountKind(runtime);
  // The cards show the rule's kind and nothing else. A Claude account the
  // runtime stores is no rule: it is what a new agent starts on, and on a
  // custom image it declares that the image runs Claude Code.
  const accountLock = namesKind ? (accounts?.kind ?? null) : null;
  // Every card unticked. No setting says that, so it is held here and the
  // runtime cannot be saved until one is ticked. It belongs to the cards it
  // was said on: another command or protocol shows its own.
  const [noAccount, setNoAccount] = useState(false);
  const cardsOf = `${runtime.command?.[0] ?? ""}:${runtime.inferenceProtocol}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the cards the runtime shows change
  useEffect(() => {
    setNoAccount(false);
  }, [cardsOf]);
  // The Claude settings the runtime is stored with: what it was opened on,
  // then what each save here wrote. One card ticked puts the runtime's Claude
  // account on that kind; both ticked again puts these back as they were, so
  // an edit that ends where it began changes nothing.
  const [storedClaudeSettings, setStoredClaudeSettings] = useState(
    () => runtime.claudeCode,
  );
  const changeAccounts = (change: RuntimeAccountsChange) => {
    if (change.lock === "none") {
      setNoAccount(true);
      return;
    }
    setNoAccount(false);
    if (claudeRuntime && change.lock !== accountLock) {
      setRuntime(
        withCustomRuntimeAccounts(runtime, change.lock, storedClaudeSettings),
      );
    }
    form.setValue(
      "accounts",
      runtimeAccountsAfter({ previous: accounts, change, namesKind }),
      { shouldDirty: true },
    );
  };
  const save = ({ accounts: held, ...values }: TemplateDraft) => {
    // Only what this runtime's cards can say is written: the kind where its
    // agents have two, and no names. Cards nobody changed write nothing.
    const saved = runtimeAccountsToSave(
      held && { ...held, kind: namesKind ? held.kind : undefined },
    );
    onSave(saved ? { ...values, accounts: saved } : values, () => {
      // What is on screen is now what is stored. The settings stay open, so
      // the next edit starts from this save, as it would on opening them.
      form.reset(form.getValues());
      setStoredClaudeSettings(values.runtime.claudeCode);
      void afterSave();
    });
  };
  const existingAgents = useRef<HTMLDivElement>(null);
  const afterSave = useShowAgentsBehindAfterSave({
    runtimeId: savedScope,
    onBehind: () => {
      setSection("runtime");
      showExistingAgents(existingAgents);
    },
  });

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
            : "Container, accounts and limits",
        },
      ]}
      wrapForm={(children) => <Form {...form}>{children}</Form>}
      onSubmit={(event) => {
        if (noAccount) {
          event.preventDefault();
          setSection("runtime");
          return;
        }
        void form.handleSubmit(save, (errors) => {
          if (errors.name) setSection("general");
          else if (errors.runtime) setSection("runtime");
        })(event);
      }}
      footer={
        <>
          <DialogCancelButton>
            {isDirty ? "Cancel" : "Close"}
          </DialogCancelButton>
          <Button type="submit" disabled={isSaving || noAccount}>
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
          <RuntimeAccountsSection
            runtime={runtime}
            claude={claudeRuntime}
            lock={accountLock}
            noneSelected={noAccount}
            accounts={accounts}
            onChange={changeAccounts}
          />
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
            anchor={existingAgents}
            runtimeId={savedScope}
            name={template?.name ?? "this runtime"}
            builtIn={false}
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
  /** Saves the runtime's settings and calls `onSaved` once they are stored. */
  onSave: (value: BuiltInRuntime, onSaved: () => void) => void;
}) {
  const name = AGENT_CATALOG_NAMES[id];
  const [section, setSection] = useState<Section>("general");
  const [initial, setInitial] = useState<AgentRuntimeConfig>(() =>
    withAgentRuntimeDefaults({
      runtime: buildAgentCatalogRuntime({ id, image }),
      defaults: value?.settings,
    }),
  );
  const [runtime, setRuntime] = useState<AgentRuntimeConfig>(initial);
  const claudeRuntime = !!runtime.claudeCode;
  const namesKind = agentRuntimeCanNameAccountKind(runtime);
  // The cards show the rule's kind and nothing else. A Claude account the
  // runtime's settings store is no rule: it is what a new agent starts on.
  const [accounts, setAccounts] = useState<RuntimeAccounts | undefined>(
    value?.settings.accounts,
  );
  const isDirty =
    JSON.stringify(runtime) !== JSON.stringify(initial) ||
    JSON.stringify(runtimeAccountsToSave(accounts)) !==
      JSON.stringify(runtimeAccountsToSave(value?.settings.accounts));
  const accountLock = namesKind ? (accounts?.kind ?? null) : null;
  // Every card unticked; see the custom runtime's editor.
  const [noAccount, setNoAccount] = useState(false);
  const changeAccounts = (change: RuntimeAccountsChange) => {
    if (change.lock === "none") {
      setNoAccount(true);
      return;
    }
    setNoAccount(false);
    setAccounts(
      runtimeAccountsAfter({ previous: accounts, change, namesKind }),
    );
  };

  const save = () => {
    const saved = runtimeAccountsToSave(accounts);
    // The runtime's Claude account follows the kind its rule names. Where
    // the rule names none, the one it stores stays as it was.
    const claudeCode =
      claudeRuntime && accountLock
        ? { authentication: claudeAccount(accountLock) }
        : value?.settings.claudeCode;
    onSave(
      {
        settings: {
          tier: runtime.tier ?? null,
          maxTier: runtime.maxTier ?? null,
          ttlHours: runtime.ttlHours,
          maxCostUsd: runtime.maxCostUsd,
          idleTimeoutMinutes: runtime.idleTimeoutMinutes,
          ...(claudeCode && { claudeCode }),
          ...(saved && { accounts: saved }),
        },
      },
      () => {
        // What is on screen is now what is stored.
        setInitial(runtime);
        void afterSave();
      },
    );
  };
  const existingAgents = useRef<HTMLDivElement>(null);
  const afterSave = useShowAgentsBehindAfterSave({
    runtimeId: id,
    onBehind: () => {
      setSection("runtime");
      showExistingAgents(existingAgents);
    },
  });

  return (
    <TabbedDialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={runtimeEditTitle(name)}
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
          status: "Accounts and limits",
        },
      ]}
      onSubmit={(event) => {
        if (noAccount) {
          event.preventDefault();
          setSection("runtime");
          return;
        }
        save();
      }}
      footer={
        <>
          <DialogCancelButton>
            {isDirty ? "Cancel" : "Close"}
          </DialogCancelButton>
          <Button type="submit" disabled={isSaving || noAccount}>
            <span>Save runtime</span>
          </Button>
        </>
      }
    >
      <div hidden={section !== "general"}>
        <SettingsSectionGroup>
          <SettingsSection
            title="Details"
            description="Built-in runtimes have a fixed name and icon."
          >
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted">
                <CatalogAgentIcon id={id} size={20} />
              </div>
              <span className="min-w-0 truncate text-sm font-medium">
                {name}
              </span>
            </div>
          </SettingsSection>
          <AccessSection scope={scope} />
        </SettingsSectionGroup>
      </div>

      <div hidden={section !== "runtime"}>
        <SettingsSectionGroup>
          <SettingsSection
            title="Container"
            description="The built-in image and client."
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
          <RuntimeAccountsSection
            runtime={runtime}
            claude={claudeRuntime}
            lock={accountLock}
            noneSelected={noAccount}
            accounts={accounts}
            onChange={changeAccounts}
          />
          <SettingsSection
            title="Limits"
            description="Run time, spend and tiers."
          >
            <AgentRuntimeLimitFields value={runtime} onChange={setRuntime} />
          </SettingsSection>
          <ExistingAgentsSection
            anchor={existingAgents}
            runtimeId={id}
            name={name}
            builtIn
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
 * A runtime's account rule holds for every agent on it as soon as it is
 * saved. Its other settings only change agents created afterwards: this
 * brings the agents created before up to date with those, on request. The
 * section says which settings that is, and what happens to the image.
 */
function ExistingAgentsSection({
  runtimeId,
  name,
  builtIn,
  blockedReason,
  anchor,
}: {
  /** Where the dialog scrolls to when it stays open for an update. */
  anchor?: React.RefObject<HTMLDivElement | null>;
  runtimeId: string | null;
  name: string;
  /**
   * A built-in runtime's image follows each release by itself: an update
   * gives agents its limits only. A custom runtime's update also gives them
   * its image, launch command, inference API and follow-up delivery.
   */
  builtIn: boolean;
  blockedReason: string | null;
}) {
  const apply = useApplyAgentRuntimeToAgents();
  const behind = useAgentsBehindRuntime(blockedReason ? null : runtimeId);
  const count = behind.data;
  const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
  return (
    <SettingsSection
      title="Existing agents"
      description={`Allowed accounts apply to every agent on this runtime as soon as you save. Other changes apply to new agents, and to existing agents once you update them here.${builtIn ? " The container image updates with each release, for every agent." : ""}`}
    >
      <div ref={anchor}>
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
                {builtIn
                  ? "Updating gives them the saved limits: idle timeout, maximum duration, metered LLM budget, default tier and scaleup tier. It does not change the container image."
                  : "Updating gives them the saved container image, launch command, inference API, follow-up delivery and limits (idle timeout, maximum duration, metered LLM budget, default tier and scaleup tier). Their own environment variables, credentials and ports stay as they are."}
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
      </div>
    </SettingsSection>
  );
}

// ===================================================================
// Shared fields
// ===================================================================

/**
 * The account rule a runtime sets for its agents, as a section of its
 * settings: the cards an agent on it shows under the same heading.
 */
function RuntimeAccountsSection(
  props: React.ComponentProps<typeof RuntimeAccountsField>,
) {
  return (
    <SettingsSection
      title="Credentials to use"
      description="Which credentials agents on this runtime may allow. Each agent's settings pick from these."
    >
      <RuntimeAccountsField {...props} />
    </SettingsSection>
  );
}

/**
 * The custom runtime after a change of its cards. One card ticked puts its
 * Claude account on that kind, which also declares that the image runs
 * Claude Code. Both ticked puts back the Claude account the runtime is
 * stored with (`opened`), or takes it away from a runtime stored with none.
 */
function withCustomRuntimeAccounts(
  runtime: AgentRuntimeConfig,
  lock: AgentAccountLock | null,
  opened: AgentRuntimeConfig["claudeCode"],
): AgentRuntimeConfig {
  if (lock) {
    return {
      ...runtime,
      claudeCode: {
        ...(runtime.claudeCode ?? opened),
        authentication: claudeAccount(lock),
      },
    };
  }
  const { claudeCode, ...rest } = runtime;
  return opened
    ? {
        ...rest,
        claudeCode: {
          ...(claudeCode ?? opened),
          authentication: opened.authentication,
        },
      }
    : rest;
}

/** The Claude account a runtime's settings store for one ticked card. */
function claudeAccount(lock: AgentAccountLock): "provider" | "subscription" {
  return lock === "key" ? "provider" : "subscription";
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

/**
 * The edit dialog's title, which names the runtime as one: "Edit Codex
 * runtime". A custom name that already ends in "runtime" is not given a
 * second one.
 */
function runtimeEditTitle(name: string): string {
  return /\bruntime$/i.test(name.trim())
    ? `Edit ${name}`
    : `Edit ${name} runtime`;
}

/**
 * What a save does to the dialog: nothing closes it. Saving a runtime keeps
 * its settings open, and where agents of this runtime still use older
 * settings it brings the block that updates them into view.
 */
function useShowAgentsBehindAfterSave(params: {
  /** Null for a runtime that is not saved yet: it has no agents. */
  runtimeId: string | null;
  onBehind: () => void;
}) {
  const countBehind = useCountAgentsBehindRuntime();
  return async () => {
    if (!params.runtimeId) return;
    // A count that cannot be read moves nothing.
    const behind = await countBehind(params.runtimeId).catch(() => 0);
    if (behind > 0) params.onBehind();
  };
}

/** Brings the existing-agents block into view once its section is shown. */
function showExistingAgents(anchor: React.RefObject<HTMLDivElement | null>) {
  requestAnimationFrame(() =>
    anchor.current?.scrollIntoView({ block: "nearest" }),
  );
}
