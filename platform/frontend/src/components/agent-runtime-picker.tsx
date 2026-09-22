"use client";

import {
  type AgentCatalogId,
  E2eTestId,
  getAgentRuntimeAllowedProtocols,
} from "@archestra/shared";
import { CircleAlert, Code } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  CatalogAgentIcon,
  getAgentCatalogTemplates,
  PlatformAgentIcon,
  useAgentCatalogImages,
} from "@/components/agent-pages/agent-catalog";
import {
  AGENT_RUNTIME_PROTOCOL_LABELS,
  type AgentRuntimeConfig,
  AgentRuntimeEnvironmentFields,
  AgentRuntimeImageFields,
  AgentRuntimeProtocolField,
  AgentRuntimeRunControls,
  AgentRuntimeSteeringField,
  defaultAgentRuntime,
} from "@/components/agent-runtime-fields";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

export type AgentRuntimeSelection = "chat" | "custom" | AgentCatalogId;

export function AgentRuntimePicker({
  selectedId,
  value,
  onSelect,
  onChange,
  modelBlock,
  modelSummary,
  modelAttention,
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
  modelAttention?: string;
}) {
  const id = useId();
  const appName = useAppName();
  const appIconLogo = useAppIconLogo();
  const runtimeEnabled = useFeature("agentRuntime");
  const templates = getAgentCatalogTemplates(useAgentCatalogImages(), appName);
  const options: Array<{
    id: AgentRuntimeSelection;
    name: string;
    runtime: AgentRuntimeConfig | null;
  }> = [
    { id: "chat", name: appName, runtime: null },
    ...templates.map((template) => ({
      id: template.id,
      name: template.name,
      runtime: template.initialValues.runtime ?? null,
    })),
    {
      id: "custom",
      name: "Custom image",
      runtime: defaultAgentRuntime(),
    },
  ];
  const [expandedRows, setExpandedRows] = useState(() =>
    defaultExpandedRows(selectedId),
  );
  useEffect(
    () => setExpandedRows(defaultExpandedRows(selectedId)),
    [selectedId],
  );
  const protocol = value
    ? AGENT_RUNTIME_PROTOCOL_LABELS[value.inferenceProtocol]
    : "";
  const steering =
    value?.steerMode === "tmux_keys" ? "Terminal input" : "Turn boundary";
  return (
    <section
      className="space-y-4"
      data-testid={E2eTestId.AgentRuntimePicker}
      aria-label="Runtime"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Runtime</h3>
        <p className="text-sm text-muted-foreground">
          Choose what runs your agent. {appName} uses its built-in harness;
          other options run their harness in a container.
        </p>
      </div>
      <RadioGroup
        aria-label="Runtime"
        value={selectedId}
        className="flex flex-wrap gap-2"
        onValueChange={(nextId) => {
          const option = options.find((item) => item.id === nextId);
          if (option) onSelect(option.id, option.runtime);
        }}
      >
        {options.map((option) => (
          <Label
            key={option.id}
            htmlFor={`${id}-option-${option.id}`}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-normal transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              selectedId === option.id
                ? "border-primary bg-primary/10"
                : "hover:bg-muted/50",
            )}
          >
            <RadioGroupItem
              className="sr-only"
              id={`${id}-option-${option.id}`}
              value={option.id}
              disabled={
                runtimeEnabled !== true &&
                option.id !== "chat" &&
                option.id !== selectedId
              }
            />
            <span
              aria-hidden="true"
              className="flex size-6 items-center justify-center rounded bg-muted"
            >
              {option.id === "chat" ? (
                <PlatformAgentIcon appIconLogo={appIconLogo} size={16} />
              ) : option.id === "custom" ? (
                <Code className="size-4" />
              ) : (
                <CatalogAgentIcon id={option.id} size={16} />
              )}
            </span>
            <span>{option.name}</span>
          </Label>
        ))}
      </RadioGroup>
      {runtimeEnabled === false && (
        <p className="text-sm text-muted-foreground">
          Your deployment administrator must enable Agent Runtime before you can
          configure a dedicated runtime.
        </p>
      )}
      <Accordion
        type="multiple"
        value={expandedRows}
        onValueChange={setExpandedRows}
        className="overflow-hidden rounded-md border"
      >
        <RuntimeRow
          id={`${id}-model`}
          value="model"
          title={
            value?.command?.[0] === "archestra-claude-code"
              ? "Authentication"
              : "Model"
          }
          summary={modelSummary}
          attention={modelAttention}
        >
          {modelBlock}
        </RuntimeRow>
        {value && (
          <>
            <RuntimeRow
              id={`${id}-image`}
              value="image"
              title="Image"
              attention={
                !value.image.trim()
                  ? "Set a container image before creating the agent"
                  : undefined
              }
              summary={`${value.image.split("/").slice(-2).join("/") || "No image set"}. ${value.command?.join(" ") || "Image default command"}`}
            >
              <AgentRuntimeImageFields
                value={value}
                onChange={(next) => {
                  const allowedProtocols = getAgentRuntimeAllowedProtocols(
                    next.command,
                  );
                  onChange({
                    ...next,
                    inferenceProtocol: allowedProtocols.includes(
                      next.inferenceProtocol,
                    )
                      ? next.inferenceProtocol
                      : allowedProtocols[0],
                  });
                }}
              />
            </RuntimeRow>
            <RuntimeRow
              id={`${id}-inference`}
              value="inference"
              title="Inference API"
              summary={`${protocol}${value.command?.[0] === "archestra-claude-code" ? ". Fixed for Claude Code" : ""}`}
            >
              <AgentRuntimeProtocolField
                value={value}
                onChange={onChange}
                hideLabel
                constrainToHarness
              />
            </RuntimeRow>
            <RuntimeRow
              id={`${id}-steering`}
              value="steering"
              title="Steering"
              summary={steering}
            >
              <AgentRuntimeSteeringField
                value={value}
                onChange={onChange}
                hideLabel
              />
            </RuntimeRow>
            <RuntimeRow
              id={`${id}-controls`}
              value="controls"
              title="Run controls"
              summary={runControlsSummary(value)}
            >
              <AgentRuntimeRunControls value={value} onChange={onChange} />
            </RuntimeRow>
            <RuntimeRow
              id={`${id}-environment`}
              value="environment"
              title="Environment variables"
              summary={environmentSummary(value)}
            >
              <AgentRuntimeEnvironmentFields
                hideLabel
                value={value}
                onChange={onChange}
              />
            </RuntimeRow>
          </>
        )}
      </Accordion>
    </section>
  );
}

function RuntimeRow({
  id,
  value,
  title,
  summary,
  attention,
  children,
}: {
  id: string;
  value: string;
  title: string;
  summary: string;
  attention?: string;
  children: ReactNode;
}) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  return (
    <AccordionItem id={id} value={value} className="px-4 last:border-b-0">
      <AccordionTrigger
        className="min-w-0 items-center hover:no-underline"
        onFocus={() => setTooltipOpen(true)}
        onBlur={() => setTooltipOpen(false)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1 text-left sm:flex-row sm:items-center sm:gap-4">
          <span className="flex shrink-0 items-center gap-2 sm:w-36">
            {title}
            {attention && (
              <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    aria-label={attention}
                    className="inline-flex shrink-0"
                  >
                    <CircleAlert
                      className="size-4 text-amber-600 dark:text-amber-400"
                      aria-hidden="true"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{attention}</TooltipContent>
              </Tooltip>
            )}
          </span>
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            {summary}
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="pt-2">{children}</AccordionContent>
    </AccordionItem>
  );
}

function defaultExpandedRows(id: AgentRuntimeSelection): string[] {
  return id === "custom" ? ["model", "image", "inference"] : ["model"];
}

function environmentSummary(value: AgentRuntimeConfig): string {
  const variables = value.environment?.length ?? 0;
  const secrets = value.credentials?.length ?? 0;
  if (!variables && !secrets) return "None";
  return `${variables} ${variables === 1 ? "variable" : "variables"}, ${secrets} ${secrets === 1 ? "secret" : "secrets"}`;
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
