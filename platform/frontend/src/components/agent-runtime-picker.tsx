"use client";

import {
  AGENT_CATALOG_IDS,
  type AgentCatalogId,
  E2eTestId,
  getAgentRuntimeAllowedProtocols,
} from "@archestra/shared";
import { Code } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  CatalogAgentIcon,
  PlatformAgentIcon,
  useAvailableAgentCatalogTemplates,
} from "@/components/agent-pages/agent-catalog";
import {
  AGENT_RUNTIME_PROTOCOL_LABELS,
  type AgentRuntimeConfig,
  AgentRuntimeContainerOptions,
  AgentRuntimeEnvironmentFields,
  AgentRuntimeImageFields,
  AgentRuntimeLimitFields,
  AgentRuntimeProtocolField,
  AgentRuntimeSteeringField,
  defaultAgentRuntime,
  LockedRuntimeNotice,
} from "@/components/agent-runtime-fields";
import { AgentRuntimeUnavailableNotice } from "@/components/agent-runtime-unavailable-notice";
import { ConfigurationRow } from "@/components/configuration-row";
import { QueryLoadError } from "@/components/query-load-error";
import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";

import { useResolveRuntimeTemplate } from "@/lib/agent-runtime-templates.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

export type AgentRuntimeSelection = string;

export function AgentRuntimePicker({
  selectedId,
  value,
  onSelect,
  onChange,
  modelBlock,
  modelSummary,
  modelCollapsedSummary,
  modelAttention,
  lockedBy,
  accountsLeftToAgent = false,
  runtimeFixes = null,
  onChangeTemplate,
}: {
  selectedId: AgentRuntimeSelection;
  value: AgentRuntimeConfig | null;
  onSelect: (
    id: AgentRuntimeSelection,
    value: AgentRuntimeConfig | null,
  ) => void;
  onChange: (value: AgentRuntimeConfig) => void;
  modelBlock: ReactNode;
  modelSummary: string;
  /** Short bar summary shown for a runtime only while the row is collapsed. */
  modelCollapsedSummary?: string;
  modelAttention?: string;
  /** The locked Agent Runtime that sets this runtime's settings, if any. */
  lockedBy?: string | null;
  /** That runtime sets no account kind: the agent's accounts stay its own. */
  accountsLeftToAgent?: boolean;
  /** What the agent's runtime fixes of its company account, if anything. */
  runtimeFixes?: "connection" | "connection-and-model" | null;
  /**
   * Set when the runtime was picked from the catalog. The picker then shows
   * that choice as a summary rather than asking a second time, and this
   * returns the reader to the catalog to choose another.
   */
  onChangeTemplate?: () => void;
}) {
  const id = useId();
  const appName = useAppName();
  const runtimeEnabled = useFeature("agentRuntime");
  const resolver = useResolveRuntimeTemplate();
  const { templates, customImageOffered, isError, isFetching, refetch } =
    useAvailableAgentCatalogTemplates();
  const offered: Array<{
    id: AgentRuntimeSelection;
    name: string;
    runtime: AgentRuntimeConfig | null;
    icon?: string | null;
  }> = [
    { id: "chat", name: appName, runtime: null },
    ...templates.map((template) => ({
      id: template.id,
      name: template.name,
      runtime: template.initialValues.runtime ?? null,
      icon: template.icon,
    })),
  ];
  // An administrator can take Custom image off the list. An agent already on
  // an image that is none of the offered runtimes keeps the choice, so its
  // settings are not replaced.
  const options =
    customImageOffered || !offered.some((option) => option.id === selectedId)
      ? [
          ...offered,
          {
            id: "custom" as const,
            name: "Custom image",
            runtime: defaultAgentRuntime(),
          },
        ]
      : offered;
  // Hiding a template must not replace an existing agent's runtime settings.
  const visibleSelectedId = options.some((option) => option.id === selectedId)
    ? selectedId
    : "custom";
  const [expandedRows, setExpandedRows] = useState(() =>
    defaultExpandedRows(selectedId),
  );
  useEffect(
    () => setExpandedRows(defaultExpandedRows(selectedId)),
    [selectedId],
  );
  const selectedOption = options.find(
    (option) => option.id === visibleSelectedId,
  );
  const showsTemplateSummary =
    !!onChangeTemplate && visibleSelectedId !== "chat";
  const protocol = value
    ? AGENT_RUNTIME_PROTOCOL_LABELS[value.inferenceProtocol]
    : "";
  // A harness that speaks one protocol has nothing to choose here.
  const protocolIsFixed =
    !!value && getAgentRuntimeAllowedProtocols(value.command).length === 1;
  const steering =
    value?.steerMode === "tmux_keys"
      ? "Typed into its terminal"
      : "Delivered between turns";
  return (
    <section
      className="space-y-4"
      data-testid={E2eTestId.AgentRuntimePicker}
      aria-label="Runtime"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Runtime</h3>
        {!showsTemplateSummary && (
          <p className="text-sm text-muted-foreground">
            Choose what runs your agent. {appName} uses its built-in harness;
            other options run their harness in a container.
          </p>
        )}
      </div>
      {showsTemplateSummary && selectedOption ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border px-4 py-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted"
          >
            <RuntimeOptionIcon
              id={selectedOption.id}
              icon={selectedOption.icon}
            />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {selectedOption.name} in its own container
            </p>
            <p className="text-xs text-muted-foreground">
              Each task starts a run. Idle runs pause and keep their files.
            </p>
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={onChangeTemplate}
          >
            Change
          </Button>
        </div>
      ) : (
        <RadioGroup
          aria-label="Runtime"
          value={visibleSelectedId}
          className="flex flex-wrap gap-2"
          onValueChange={(nextId) => {
            const option = options.find((item) => item.id === nextId);
            if (!option || resolver.isPending) return;
            const template = templates.find((item) => item.id === option.id);
            if (template?.customTemplateId)
              resolver.mutate(template.customTemplateId, {
                onSuccess: (resolved) => onSelect(option.id, resolved.runtime),
              });
            else onSelect(option.id, option.runtime);
          }}
        >
          {options.map((option) => (
            <Label
              key={option.id}
              htmlFor={`${id}-option-${option.id}`}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 font-normal",
                radioCardClass({ checked: visibleSelectedId === option.id }),
              )}
            >
              <RadioGroupItem
                className="sr-only"
                id={`${id}-option-${option.id}`}
                value={option.id}
                disabled={
                  resolver.isPending ||
                  (runtimeEnabled !== true &&
                    option.id !== "chat" &&
                    option.id !== selectedId)
                }
              />
              <span
                aria-hidden="true"
                className="flex size-6 items-center justify-center rounded bg-muted"
              >
                <RuntimeOptionIcon
                  id={option.id}
                  icon={option.icon}
                  size={16}
                />
              </span>
              <span>{option.name}</span>
            </Label>
          ))}
        </RadioGroup>
      )}
      {isError && !isFetching && (
        <QueryLoadError
          title="Could not load Agent Runtimes"
          onRetry={() => refetch()}
        />
      )}
      {runtimeEnabled === false && <AgentRuntimeUnavailableNotice />}
      {lockedBy && (
        <LockedRuntimeNotice
          name={lockedBy}
          accountsLeftToAgent={accountsLeftToAgent}
          fixes={runtimeFixes}
        />
      )}
      <Accordion
        type="multiple"
        value={expandedRows}
        onValueChange={setExpandedRows}
        className="overflow-hidden rounded-md border"
      >
        <ConfigurationRow
          id={`${id}-model`}
          value="model"
          title={value ? "Credentials to use" : "Model"}
          // A runtime's row lists its credentials below; omit the bar summary
          // while open, and only surface an explicit collapsed summary when closed.
          summary={
            value
              ? expandedRows.includes("model")
                ? undefined
                : modelCollapsedSummary
              : modelSummary
          }
          attention={modelAttention}
        >
          {modelBlock}
        </ConfigurationRow>
        {value && (
          <>
            <ConfigurationRow
              id={`${id}-image`}
              value="image"
              title="Image"
              description="The container image each run starts from."
              attention={
                !value.image.trim()
                  ? "Set a container image before creating the agent"
                  : !value.command?.length
                    ? "Set a command before creating the agent"
                    : undefined
              }
              summary={
                showsTemplateSummary
                  ? value.image.split("/").at(-1) || "No image set"
                  : `${value.image.split("/").slice(-2).join("/") || "No image set"}. ${value.command?.join(" ") || "No command set"}`
              }
            >
              <AgentRuntimeImageFields
                value={value}
                onChange={(next) => {
                  const allowedProtocols = getAgentRuntimeAllowedProtocols(
                    next.command,
                  );
                  const inferenceProtocol = allowedProtocols.includes(
                    next.inferenceProtocol,
                  )
                    ? next.inferenceProtocol
                    : allowedProtocols[0];
                  const { claudeCode: _claudeCode, ...withoutClaudeCode } =
                    next;
                  onChange({
                    ...(inferenceProtocol === "anthropic"
                      ? next
                      : withoutClaudeCode),
                    inferenceProtocol,
                  });
                }}
              />
            </ConfigurationRow>
            {!protocolIsFixed && (
              <ConfigurationRow
                id={`${id}-inference`}
                value="inference"
                title="Inference API"
                description="The API the harness uses to call models."
                summary={protocol}
              >
                <fieldset disabled={!!lockedBy}>
                  <AgentRuntimeProtocolField
                    value={value}
                    onChange={onChange}
                    hideLabel
                    constrainToHarness
                  />
                </fieldset>
              </ConfigurationRow>
            )}
            <ConfigurationRow
              id={`${id}-steering`}
              value="steering"
              title="Follow-up messages"
              description="What happens to a message you send while it works."
              summary={steering}
            >
              <fieldset disabled={!!lockedBy}>
                <AgentRuntimeSteeringField
                  value={value}
                  onChange={onChange}
                  hideLabel
                />
              </fieldset>
            </ConfigurationRow>
            <ConfigurationRow
              id={`${id}-controls`}
              value="controls"
              title="Limits"
              description="Idle timeout, maximum duration, spend cap, CPU and memory."
              summary={runControlsSummary(value)}
            >
              <div className="space-y-5">
                <fieldset disabled={!!lockedBy}>
                  <AgentRuntimeLimitFields value={value} onChange={onChange} />
                </fieldset>
                <AgentRuntimeContainerOptions
                  value={value}
                  onChange={onChange}
                />
              </div>
            </ConfigurationRow>
          </>
        )}
      </Accordion>
      {value && (
        // Its own block, always open: this is where a run gets the tokens
        // it needs, and a collapsed row with "None" was never opened.
        <section
          aria-label="Credentials and environment"
          className="rounded-xl border bg-card p-5"
        >
          <AgentRuntimeEnvironmentFields value={value} onChange={onChange} />
        </section>
      )}
    </section>
  );
}

function RuntimeOptionIcon({
  id,
  icon,
  size = 20,
}: {
  id: AgentRuntimeSelection;
  icon?: string | null;
  size?: number;
}) {
  const appIconLogo = useAppIconLogo();
  if (id === "chat")
    return <PlatformAgentIcon appIconLogo={appIconLogo} size={size} />;
  if (id === "custom") return <Code className="size-4" />;
  if (!AGENT_CATALOG_IDS.includes(id as AgentCatalogId))
    return <AgentIcon icon={icon} size={size} />;
  return <CatalogAgentIcon id={id as AgentCatalogId} size={size} />;
}

function defaultExpandedRows(id: AgentRuntimeSelection): string[] {
  return id === "custom" ? ["model", "image", "inference"] : ["model"];
}

function runControlsSummary(value: AgentRuntimeConfig): string {
  const parts = [];
  if (value.idleTimeoutMinutes !== null)
    parts.push(`${value.idleTimeoutMinutes} min idle`);
  if (value.ttlHours !== null) parts.push(`${value.ttlHours} hr maximum`);
  if (value.resources && Object.values(value.resources).some(Boolean))
    parts.push("Custom resources");
  if (value.privileged) parts.push("Privileged mode");
  if (!parts.length) parts.push("Installation defaults");
  parts.push(
    value.maxCostUsd === null
      ? "No LLM budget"
      : `$${value.maxCostUsd} LLM budget`,
  );
  return `${parts.join(". ")}.`;
}
