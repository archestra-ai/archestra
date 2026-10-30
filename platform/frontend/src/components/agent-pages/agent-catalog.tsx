import {
  AGENT_CATALOG_IDS,
  AGENT_CATALOG_IMAGE_REGISTRY,
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  buildAgentCatalogRuntime,
  buildAgentCatalogSystemPrompt,
  buildCustomAgentRuntime,
  getAgentCatalogImages,
  MESSAGING_CHANNEL_LABELS,
  orderedPopularAgentIds,
} from "@archestra/shared";
import {
  Bot,
  Code,
  Info,
  Laptop,
  type LucideIcon,
  MessageSquare,
  Network,
  Share2,
} from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import type { AgentFormInitialValues } from "@/components/agent-form";
import { AgentIcon } from "@/components/agent-icon";
import { CATALOG_AGENT_ICONS } from "@/components/agent-icon.utils";
import { AgentRuntimeUnavailableNotice } from "@/components/agent-runtime-unavailable-notice";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { CHANNEL_ICON_SRC, ChannelIcon } from "@/components/channel-icon";
import { ClientMarkTile } from "@/components/client-mark-tile";
import { CATALOG_AGENT_MARKS } from "@/components/client-marks";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { runtimeTemplatePosition } from "@/lib/agent-runtime-template-order";
import {
  useResolveRuntimeTemplate,
  useRuntimeTemplateCatalog,
} from "@/lib/agent-runtime-templates.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
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
  const catalog = getAgentCatalogTemplates(images, appName);
  const custom = useRuntimeTemplateCatalog();
  const builtIns = orderedPopularAgentIds(
    organization?.popularAgentOverrides ?? null,
    AGENT_CATALOG_IDS,
  ).flatMap((id) => catalog.filter((item) => item.id === id));
  const templates =
    organization &&
    !isError &&
    !custom.isError &&
    !isFetching &&
    !custom.isFetching
      ? [
          ...builtIns,
          ...(custom.data ?? [])
            .filter((item) => !item.hidden)
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
    custom.isPending;
  return {
    templates,
    isError: isError || custom.isError,
    isFetching: isFetching || custom.isFetching,
    isLoading,
    refetch: () => Promise.all([refetch(), custom.refetch()]),
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
  const { templates, isError, isLoading, refetch } =
    useAvailableAgentCatalogTemplates();
  const resolver = useResolveRuntimeTemplate();
  const appName = useAppName();
  const appIconLogo = useAppIconLogo();
  const { data: canConfigureRuntime } = useHasPermissions({
    agent: ["configure-runtime"],
  });
  return (
    <div className="space-y-10">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <CatalogSourceCard
          icon={<PlatformAgentIcon appIconLogo={appIconLogo} />}
          title={`New ${appName} agent`}
          description={`Built into ${appName}. The easiest place to start.`}
          onClick={onStartFromScratch}
          disabled={!canCreateAgent}
          disabledReason="Requires permission to create agents."
        />
      </div>

      {/* Always laid out, so it does not pop in and push the rest down; only
          its cards wait for the fresh settings read that decides which
          Agent Runtimes are offered. */}
      <CatalogSection
        title={
          <>
            <span>Agent Runtimes</span>{" "}
            <Badge
              variant="outline"
              className="align-middle border-transparent bg-sidebar-chip px-1.5 py-0 text-[10px] text-sidebar-emphasis dark:border-sidebar-emphasis dark:bg-sidebar"
            >
              Beta
            </Badge>
          </>
        }
        description={`Each one runs in its own container, with a live terminal and files that persist between messages. Its model and tool calls go through ${appName}, so logs, guardrails and cost limits apply.`}
      >
        {canConfigureRuntime === false && (
          <InlineNotice variant="info">
            <Info className="size-4 shrink-0" />
            <InlineNoticeBody>
              <span className="font-medium">
                Configure runtime permission required
              </span>
              <InlineNoticeText>
                You can still create ordinary agents. Ask an administrator to
                enable runtime configuration for your role.
              </InlineNoticeText>
            </InlineNoticeBody>
          </InlineNotice>
        )}
        {runtimeAvailable === false && <AgentRuntimeUnavailableNotice />}
        <GiveItWorkFrom />
        {runtimeAvailable === undefined || isLoading ? (
          <output
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            aria-label="Loading Agent Runtimes"
          >
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-[132px] rounded-xl" />
            ))}
          </output>
        ) : isError ? (
          <QueryLoadError
            title="Could not load Agent Runtimes"
            onRetry={() => refetch()}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                  !canConfigureRuntime ||
                  !runtimeAvailable ||
                  resolver.isPending
                }
                disabledReason={
                  canCreateAgent
                    ? !canConfigureRuntime
                      ? "Requires Configure runtime permission."
                      : "Requires the Agent Sandbox controller."
                    : "Requires permission to create agents."
                }
              />
            ))}
            <CatalogSourceCard
              icon={<Code className="size-5" />}
              title="Custom image"
              description="Run your own container image and command."
              onClick={onStartFromImage}
              disabled={
                !canCreateAgent || !canConfigureRuntime || !runtimeAvailable
              }
              disabledReason={
                canCreateAgent
                  ? !canConfigureRuntime
                    ? "Requires Configure runtime permission."
                    : "Requires the Agent Sandbox controller."
                  : "Requires permission to create agents."
              }
            />
          </div>
        )}
      </CatalogSection>

      <CatalogSection
        title="External agents"
        description="Agents hosted somewhere else. Your agents can hand them work as subagents."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <CatalogSourceCard
            icon={<Network className="size-5" />}
            title="Connect via A2A"
            description="Connect an A2A-compatible agent by its URL."
            onClick={onAddExternalAgent}
            disabled={!canCreateAgent}
            disabledReason="Requires permission to create agents."
          />
        </div>
      </CatalogSection>
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
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** Where an Agent Runtime's tasks can come from, so the reader knows before picking. */
function GiveItWorkFrom() {
  const appName = useAppName();
  const { visibleIds } = useMessagingChannelCatalog();
  // Chat apps only, and only the ones the admins left switched on.
  const messengers = visibleIds.filter((id) => id in CHANNEL_ICON_SRC);
  const source = ({
    Icon,
    label,
    compactLabel,
  }: {
    Icon: LucideIcon;
    label: string;
    compactLabel?: string;
  }) => (
    <span
      key={label}
      className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {compactLabel ? (
        <>
          <span className="sm:hidden">{compactLabel}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-lg bg-muted px-4 py-3 text-sm sm:flex sm:flex-wrap sm:gap-x-5">
      <span className="font-medium">Give it work from</span>
      {messengers.length > 0 && (
        <span className="flex items-center gap-2 sm:order-2">
          {messengers.map((id) => (
            <span key={id} title={MESSAGING_CHANNEL_LABELS[id]}>
              <ChannelIcon channel={id} className="size-4" />
              <span className="sr-only">{MESSAGING_CHANNEL_LABELS[id]}</span>
            </span>
          ))}
        </span>
      )}
      <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-2 sm:contents sm:[&>span]:order-3 sm:[&>span:first-child]:order-1">
        {source({
          Icon: MessageSquare,
          label: `${appName} chat`,
          compactLabel: "Chat",
        })}
        {source({
          Icon: Laptop,
          label: "Handoff from a local coding agent",
          compactLabel: "Handoff",
        })}
        {source({ Icon: Share2, label: "Other agents" })}
      </div>
    </div>
  );
}
