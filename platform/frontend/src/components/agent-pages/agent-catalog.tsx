import {
  AGENT_CATALOG_IDS,
  AGENT_CATALOG_IMAGE_REGISTRY,
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  buildAgentCatalogRuntime,
  buildAgentCatalogSystemPrompt,
  buildCustomAgentRuntime,
  CHAT_APP_CHANNEL_IDS,
  CUSTOM_IMAGE_RUNTIME_ID,
  getAgentCatalogImages,
  isIntegrationHidden,
  MESSAGING_CHANNEL_LABELS,
  orderedPopularAgentIds,
  withAgentRuntimeDefaults,
} from "@archestra/shared";
import { Bot, Code, Laptop, MessageSquare, Network } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import type { AgentFormInitialValues } from "@/components/agent-form";
import { AgentIcon } from "@/components/agent-icon";
import { CATALOG_AGENT_ICONS } from "@/components/agent-icon.utils";
import { AgentRuntimeUnavailableNotice } from "@/components/agent-runtime-unavailable-notice";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { ChannelIcon } from "@/components/channel-icon";
import { ClientMarkTile } from "@/components/client-mark-tile";
import { CATALOG_AGENT_MARKS } from "@/components/client-marks";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { runtimeTemplatePosition } from "@/lib/agent-runtime-template-order";
import {
  useAgentRuntimeAccess,
  useBuiltInRuntimeDefaults,
  useResolveRuntimeTemplate,
  useRuntimeTemplateCatalog,
} from "@/lib/agent-runtime-templates.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { useOrganization } from "@/lib/organization.query";

export interface AgentCatalogTemplate {
  id: string;
  customTemplateId?: string;
  name: string;
  description: string;
  /** What the catalog card says: how it runs and who pays for it. */
  summary: string;
  icon: string | null;
  initialValues: AgentFormInitialValues;
}

/** Shared by the catalog card and the runtime pill. */
export const AGENT_CATALOG_TEMPLATE_NAMES = AGENT_CATALOG_NAMES;

/** The maintained image per template, as this deployment pulls it. */
export function useAgentCatalogImages(): Record<AgentCatalogId, string> {
  const configured = useFeature("agentRuntimeCatalogImages");
  return configured
    ? (configured as Record<AgentCatalogId, string>)
    : getAgentCatalogImages({
        registry: AGENT_CATALOG_IMAGE_REGISTRY,
        tag: "latest",
      });
}

export function getAgentCatalogTemplates(
  images: Record<AgentCatalogId, string>,
  // white-label-ok: test/helper fallback only; shipped UI always passes useAppName().
  appName = "Archestra",
): readonly AgentCatalogTemplate[] {
  return [
    template({
      id: "claude-code",
      name: AGENT_CATALOG_TEMPLATE_NAMES["claude-code"],
      summary:
        "Anthropic's coding agent. Runs on each person's Claude Pro or Max, or a company Anthropic key.",
      icon: CATALOG_AGENT_ICONS["claude-code"],
      description: `Anthropic's coding agent with personal Claude sign-in or provider billing, connected to the ${appName} MCP gateway.`,
      platformName: appName,
      image: images["claude-code"],
    }),
    template({
      id: "codex",
      name: AGENT_CATALOG_TEMPLATE_NAMES.codex,
      summary:
        "OpenAI's coding agent. Runs on each person's ChatGPT subscription.",
      icon: CATALOG_AGENT_ICONS.codex,
      description: `OpenAI's coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.codex,
    }),
    template({
      id: "opencode",
      name: AGENT_CATALOG_TEMPLATE_NAMES.opencode,
      summary: `The open source coding agent. Uses any model your company set up in ${appName}.`,
      icon: CATALOG_AGENT_ICONS.opencode,
      description: `The open source coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.opencode,
    }),
    template({
      id: "hermes",
      name: AGENT_CATALOG_TEMPLATE_NAMES.hermes,
      summary: `The Hermes coding agent. Uses any model your company set up in ${appName}.`,
      icon: CATALOG_AGENT_ICONS.hermes,
      description: `The Hermes coding agent with its model and remote MCP tools supplied by ${appName}.`,
      platformName: appName,
      image: images.hermes,
    }),
    template({
      id: "openclaw",
      name: AGENT_CATALOG_TEMPLATE_NAMES.openclaw,
      summary: `OpenClaw in an isolated task pod. Uses any model your company set up in ${appName}.`,
      icon: CATALOG_AGENT_ICONS.openclaw,
      description: `OpenClaw in an isolated task pod, with inference and MCP access kept behind ${appName}.`,
      platformName: appName,
      image: images.openclaw,
    }),
    template({
      id: "grok",
      name: AGENT_CATALOG_TEMPLATE_NAMES.grok,
      summary:
        "xAI's coding agent. Runs on each person's SuperGrok subscription or an xAI API key.",
      icon: CATALOG_AGENT_ICONS.grok,
      description: `xAI's coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.grok,
    }),
    template({
      id: "kimi",
      name: AGENT_CATALOG_TEMPLATE_NAMES.kimi,
      summary: "Kimi's coding agent. Runs on a Kimi Code membership.",
      icon: CATALOG_AGENT_ICONS.kimi,
      description: `Kimi's coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.kimi,
    }),
    template({
      id: "copilot",
      name: AGENT_CATALOG_TEMPLATE_NAMES.copilot,
      summary: `GitHub's coding agent. Uses a model and credentials configured in ${appName}.`,
      icon: CATALOG_AGENT_ICONS.copilot,
      description: `GitHub Copilot CLI with inference through the ${appName} LLM proxy and tools through its MCP gateway.`,
      platformName: appName,
      image: images.copilot,
    }),
  ] as const;
}

/** One saved selection controls catalog suggestions and runtime image choices. */
export function useAvailableAgentCatalogTemplates() {
  const appName = useAppName();
  const images = useAgentCatalogImages();
  const {
    data: organization,
    isError,
    isFetching,
    refetch,
  } = useOrganization(true, { fresh: true });
  const builtInDefaults = useBuiltInRuntimeDefaults();
  const catalog = getAgentCatalogTemplates(images, appName).map((template) => ({
    ...template,
    initialValues: {
      ...template.initialValues,
      runtime:
        template.initialValues.runtime &&
        withAgentRuntimeDefaults({
          runtime: template.initialValues.runtime,
          defaults: builtInDefaults(template.id as AgentCatalogId),
        }),
    },
  }));
  const custom = useRuntimeTemplateCatalog();
  const access = useAgentRuntimeAccess();
  const usable = new Set(
    access.data?.runtimes.filter((item) => item.canUse).map((item) => item.id),
  );
  const builtIns = orderedPopularAgentIds(
    organization?.popularAgentOverrides ?? null,
    AGENT_CATALOG_IDS,
  ).flatMap((id) => catalog.filter((item) => item.id === id && usable.has(id)));
  const templates =
    organization &&
    access.data &&
    !isError &&
    !custom.isError &&
    !access.isError &&
    !isFetching &&
    !custom.isFetching
      ? [
          ...builtIns,
          ...(custom.data ?? [])
            .filter((item) => !item.hidden && usable.has(item.id))
            .map(
              (item): AgentCatalogTemplate => ({
                id: item.id,
                customTemplateId: item.id,
                name: item.name,
                description: item.description,
                summary:
                  item.description ||
                  "Run an agent from this custom runtime template.",
                icon: item.icon,
                initialValues: {
                  name: item.name,
                  description: item.description,
                  icon: item.icon,
                  accessAllTools: true,
                  runtime: buildCustomAgentRuntime({ image: item.image }),
                },
              }),
            ),
        ].sort((a, b) => {
          const position = (id: string) =>
            runtimeTemplatePosition(
              id,
              custom.data ?? [],
              organization.popularAgentOverrides,
            );
          return position(a.id) - position(b.id);
        })
      : [];
  const isLoading =
    isFetching ||
    custom.isFetching ||
    (!organization && !isError) ||
    custom.isPending ||
    access.isPending;
  return {
    templates,
    /** Whether the reader may run an image that is none of the runtimes. */
    canUseCustomImage:
      access.data?.canConfigureAny === true &&
      !!organization &&
      !isIntegrationHidden(
        organization.popularAgentOverrides,
        CUSTOM_IMAGE_RUNTIME_ID,
      ),
    /** Whether the reader may use any runtime; undefined while loading. */
    hasRuntimeAccess: access.data
      ? access.data.canConfigureAny ||
        access.data.runtimes.some((item) => item.canUse)
      : undefined,
    isError: isError || custom.isError || access.isError,
    isFetching: isFetching || custom.isFetching || access.isFetching,
    isLoading,
    refetch: () => Promise.all([refetch(), custom.refetch(), access.refetch()]),
  };
}

export function AgentCatalog({
  canCreateAgent,
  onStartFromScratch,
  onStartFromImage,
  onAddExternalAgent,
  onSelect,
  runtimeAvailable,
}: {
  /** Building an agent and connecting an external one both need Agent create. */
  canCreateAgent: boolean;
  onStartFromScratch: () => void;
  /** Starts a container agent from the reader's own image. */
  onStartFromImage: () => void;
  onAddExternalAgent: () => void;
  onSelect: (template: AgentCatalogTemplate) => void;
  /** Agent Runtimes run in a dedicated container; undefined while loading. */
  runtimeAvailable: boolean | undefined;
}) {
  const {
    templates,
    canUseCustomImage,
    hasRuntimeAccess,
    isError,
    isLoading,
    refetch,
  } = useAvailableAgentCatalogTemplates();
  const resolver = useResolveRuntimeTemplate();
  const appName = useAppName();
  const appIconLogo = useAppIconLogo();
  // Runtimes the reader may use; nothing to show when there are none.
  const showsRuntimes = hasRuntimeAccess === true;
  return (
    <div className="space-y-6">
      {showsRuntimes && runtimeAvailable === false && (
        <AgentRuntimeUnavailableNotice />
      )}
      <div className="space-y-12">
        <CatalogSection
          title="Choose an agent"
          description={`Start with ${appName} or another agent. Configure it on the next page.`}
        >
          <GiveItWorkFrom showsRuntimes={showsRuntimes} />
          <div className="grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <CatalogSourceCard
              icon={<PlatformAgentIcon appIconLogo={appIconLogo} />}
              title={appName}
              description={`Built into ${appName} for chat. Choose its model, instructions, and tools.`}
              onClick={onStartFromScratch}
              disabled={!canCreateAgent}
              disabledReason="Requires permission to create agents."
            />
            {showsRuntimes &&
              (runtimeAvailable === undefined || isLoading ? (
                <output
                  className="contents"
                  aria-label="Loading Agent Runtimes"
                >
                  {[0, 1, 2].map((index) => (
                    <Skeleton key={index} className="h-[132px] rounded-xl" />
                  ))}
                </output>
              ) : isError ? (
                <div className="col-span-full">
                  <QueryLoadError
                    title="Could not load Agent Runtimes"
                    onRetry={() => refetch()}
                  />
                </div>
              ) : (
                <>
                  {templates.map((item) => (
                    <CatalogSourceCard
                      key={item.id}
                      icon={
                        item.customTemplateId ? (
                          <AgentIcon icon={item.icon} size={22} />
                        ) : (
                          <CatalogAgentIcon id={item.id as AgentCatalogId} />
                        )
                      }
                      title={item.name}
                      description={item.summary}
                      onClick={() => {
                        if (item.customTemplateId)
                          resolver.mutate(item.customTemplateId, {
                            onSuccess: (template) =>
                              onSelect({
                                ...item,
                                initialValues: {
                                  ...item.initialValues,
                                  runtime: template.runtime,
                                },
                              }),
                          });
                        else onSelect(item);
                      }}
                      disabled={
                        !canCreateAgent ||
                        !runtimeAvailable ||
                        resolver.isPending
                      }
                      disabledReason={
                        canCreateAgent
                          ? "Requires the Agent Sandbox controller."
                          : "Requires permission to create agents."
                      }
                    />
                  ))}
                  {canUseCustomImage && (
                    <CatalogSourceCard
                      icon={<Code className="size-5" />}
                      title="Custom image"
                      description="Run your own container image and command."
                      onClick={onStartFromImage}
                      disabled={!canCreateAgent || !runtimeAvailable}
                      disabledReason={
                        canCreateAgent
                          ? "Requires the Agent Sandbox controller."
                          : "Requires permission to create agents."
                      }
                    />
                  )}
                </>
              ))}
          </div>
        </CatalogSection>

        <CatalogSection
          title="Connect an external agent"
          description="Already running elsewhere? Connect it so your agents can delegate work to it."
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <CatalogSourceCard
              icon={<Network className="size-5" />}
              title="Connect via A2A"
              description="Connect an agent hosted elsewhere using its URL."
              onClick={onAddExternalAgent}
              disabled={!canCreateAgent}
              disabledReason="Requires permission to create agents."
            />
          </div>
        </CatalogSection>
      </div>
    </div>
  );
}

/** The platform's own (white-labeled) logo, for its built-in harness. */
export function PlatformAgentIcon({
  appIconLogo,
  size = 22,
}: {
  appIconLogo: string | null;
  size?: number;
}) {
  return appIconLogo ? (
    <Image
      src={appIconLogo}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="rounded-sm object-contain"
    />
  ) : (
    <Bot className="size-5" />
  );
}

/** A catalog template's logo, drawn as the Connect page draws it. */
export function CatalogAgentIcon({
  id,
  size = 22,
}: {
  id: AgentCatalogId;
  size?: number;
}) {
  return (
    <ClientMarkTile
      mark={CATALOG_AGENT_MARKS[id]}
      label={AGENT_CATALOG_NAMES[id]}
      size={size}
    />
  );
}

function template(params: {
  id: AgentCatalogId;
  name: string;
  description: string;
  summary: string;
  icon: string | null;
  platformName: string;
  image: string;
}): AgentCatalogTemplate {
  return {
    id: params.id,
    name: params.name,
    description: params.description,
    summary: params.summary,
    icon: params.icon,
    initialValues: {
      name: params.name,
      icon: params.icon,
      description: params.description,
      systemPrompt: buildAgentCatalogSystemPrompt({
        name: params.name,
        platformName: params.platformName,
      }),
      accessAllTools: true,
      runtime: buildAgentCatalogRuntime({ id: params.id, image: params.image }),
    },
  };
}

function CatalogSection({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Where an agent's tasks can come from, so the reader knows before picking.
 * Handoff starts a run in an Agent Runtime, so only a reader who may use one
 * is told about it.
 */
function GiveItWorkFrom({ showsRuntimes }: { showsRuntimes: boolean }) {
  const appName = useAppName();
  const { isHidden } = useMessagingChannelCatalog();
  // Jira and email are messaging channels too, but a logo with no name says
  // little here: the strip names the chat apps and leaves the rest to the
  // agent's own page.
  const messengers = CHAT_APP_CHANNEL_IDS.filter((id) => !isHidden(id));
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-muted px-4 py-3 text-sm">
      <span className="font-semibold">Give it work from</span>
      <WorkSource
        icon={
          <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
        }
        label={`${appName} chat`}
      />
      {messengers.length > 0 && (
        <WorkSource
          icon={
            <span className="flex items-center gap-1.5">
              {messengers.map((id) => (
                <span key={id} title={MESSAGING_CHANNEL_LABELS[id]}>
                  <ChannelIcon channel={id} className="size-4" />
                  <span className="sr-only">
                    {MESSAGING_CHANNEL_LABELS[id]}
                  </span>
                </span>
              ))}
            </span>
          }
          label="Your messenger"
        />
      )}
      {showsRuntimes && (
        <WorkSource
          icon={<Laptop className="size-3.5 shrink-0" aria-hidden="true" />}
          label="Handoff from a coding agent"
        />
      )}
      <WorkSource
        icon={<Bot className="size-3.5 shrink-0" aria-hidden="true" />}
        label="Another agent"
      />
    </div>
  );
}

function WorkSource({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
      {icon}
      <span>{label}</span>
    </span>
  );
}
