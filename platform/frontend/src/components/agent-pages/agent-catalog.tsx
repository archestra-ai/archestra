import {
  AGENT_CATALOG_IMAGE_REGISTRY,
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  buildAgentCatalogRuntime,
  buildAgentCatalogSystemPrompt,
  getAgentCatalogImages,
  MESSAGING_CHANNEL_LABELS,
  orderedPopularAgentIds,
} from "@archestra/shared";
import {
  Bot,
  Code,
  Laptop,
  type LucideIcon,
  MessageSquare,
  Network,
  Share2,
} from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import type { AgentFormInitialValues } from "@/components/agent-form";
import { AgentRuntimeUnavailableNotice } from "@/components/agent-runtime-unavailable-notice";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { CHANNEL_ICON_SRC, ChannelIcon } from "@/components/channel-icon";
import { ProviderIcon } from "@/components/provider-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useFeature } from "@/lib/config/config.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { useOrganization } from "@/lib/organization.query";

export interface AgentCatalogTemplate {
  id: AgentCatalogId;
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
      icon: "/model-logos/anthropic.svg",
      description: `Anthropic's coding agent with personal Claude sign-in or provider billing, connected to the ${appName} MCP gateway.`,
      platformName: appName,
      image: images["claude-code"],
    }),
    template({
      id: "codex",
      name: AGENT_CATALOG_TEMPLATE_NAMES.codex,
      summary:
        "OpenAI's coding agent. Runs on each person's ChatGPT subscription.",
      icon: "/model-logos/openai.svg",
      description: `OpenAI's coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.codex,
    }),
    template({
      id: "opencode",
      name: AGENT_CATALOG_TEMPLATE_NAMES.opencode,
      summary: `The open source coding agent. Uses any model your company set up in ${appName}.`,
      icon: "/agent-logos/opencode.svg",
      description: `The open source coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.opencode,
    }),
    template({
      id: "hermes",
      name: AGENT_CATALOG_TEMPLATE_NAMES.hermes,
      summary: `The Hermes coding agent. Uses any model your company set up in ${appName}.`,
      icon: "/agent-logos/hermes.png",
      description: `The Hermes coding agent with its model and remote MCP tools supplied by ${appName}.`,
      platformName: appName,
      image: images.hermes,
    }),
    template({
      id: "openclaw",
      name: AGENT_CATALOG_TEMPLATE_NAMES.openclaw,
      summary: `OpenClaw in an isolated task pod. Uses any model your company set up in ${appName}.`,
      icon: "/agent-logos/openclaw.svg",
      description: `OpenClaw in an isolated task pod, with inference and MCP access kept behind ${appName}.`,
      platformName: appName,
      image: images.openclaw,
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
  const templates =
    organization && !isError && !isFetching
      ? orderedPopularAgentIds(
          organization.popularAgentOverrides ?? null,
          catalog.map((item) => item.id),
        ).flatMap((id) => catalog.filter((item) => item.id === id))
      : [];
  // Nothing to offer yet: the first read has not answered, or a fresh one is
  // still on its way.
  const isLoading = isFetching || (!organization && !isError);
  return { templates, isError, isFetching, isLoading, refetch };
}

export function AgentCatalog({
  canAddExternalAgent,
  canCreateAgent,
  onStartFromScratch,
  onStartFromImage,
  onAddExternalAgent,
  onSelect,
  runtimeAvailable,
}: {
  canAddExternalAgent: boolean;
  canCreateAgent: boolean;
  onStartFromScratch: () => void;
  /** Starts a container agent from the reader's own image. */
  onStartFromImage: () => void;
  onAddExternalAgent: () => void;
  onSelect: (template: AgentCatalogTemplate) => void;
  /** Coding agents run in a dedicated runtime; undefined while loading. */
  runtimeAvailable: boolean | undefined;
}) {
  const { templates, isError, isLoading, refetch } =
    useAvailableAgentCatalogTemplates();
  const appName = useAppName();
  const appIconLogo = useAppIconLogo();
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
          coding agents are offered. */}
      <CatalogSection
        title={
          <>
            <span>Coding agents</span>{" "}
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
        {runtimeAvailable === false && <AgentRuntimeUnavailableNotice />}
        <GiveItWorkFrom />
        {runtimeAvailable === undefined || isLoading ? (
          <output
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            aria-label="Loading coding agents"
          >
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-[132px] rounded-xl" />
            ))}
          </output>
        ) : isError ? (
          <QueryLoadError
            title="Could not load coding agents"
            onRetry={() => refetch()}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((item) => (
              <CatalogSourceCard
                key={item.id}
                icon={<CatalogAgentIcon id={item.id} />}
                title={item.name}
                description={item.summary}
                onClick={() => onSelect(item)}
                disabled={!canCreateAgent || !runtimeAvailable}
                disabledReason={
                  canCreateAgent
                    ? "Requires the Agent Sandbox controller."
                    : "Requires permission to create agents."
                }
              />
            ))}
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
            disabled={!canAddExternalAgent}
            disabledReason="Requires permission to view agents and update agent settings."
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

export function CatalogAgentIcon({
  id,
  size = 22,
}: {
  id: AgentCatalogId;
  size?: number;
}) {
  const box = { width: size, height: size };
  switch (id) {
    case "claude-code":
      return <ProviderIcon provider="anthropic" size={size} />;
    case "codex":
      return <ProviderIcon provider="openai" size={size} />;
    case "opencode":
      return (
        <Image
          src="/agent-logos/opencode.svg"
          alt=""
          width={size}
          height={size}
          style={{ height: size }}
          className="w-auto object-contain dark:invert"
        />
      );
    case "hermes": {
      // The artwork carries its own padding, so it draws larger than its peers.
      const hermesSize = Math.round((size * 30) / 22);
      return (
        <Image
          src="/agent-logos/hermes.png"
          alt=""
          width={hermesSize}
          height={hermesSize}
          style={{ width: hermesSize, height: hermesSize }}
          className="rounded-md object-contain"
        />
      );
    }
    case "openclaw":
      return (
        <Image
          src="/agent-logos/openclaw.svg"
          alt=""
          width={size}
          height={size}
          style={box}
          className="object-contain"
        />
      );
    default:
      return <Bot className="size-5" />;
  }
}

function template(params: {
  id: AgentCatalogTemplate["id"];
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

/** Where a coding agent's tasks can come from, so the reader knows before picking. */
function GiveItWorkFrom() {
  const appName = useAppName();
  const { visibleIds } = useMessagingChannelCatalog();
  // Chat apps only, and only the ones the admins left switched on.
  const messengers = visibleIds.filter((id) => id in CHANNEL_ICON_SRC);
  const source = (Icon: LucideIcon, label: string) => (
    <span
      key={label}
      className="flex items-center gap-1.5 text-muted-foreground"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-muted px-4 py-3 text-sm">
      <span className="font-medium">Give it work from</span>
      {source(MessageSquare, `${appName} chat`)}
      {messengers.length > 0 && (
        <span className="flex items-center gap-2">
          {messengers.map((id) => (
            <span key={id} title={MESSAGING_CHANNEL_LABELS[id]}>
              <ChannelIcon channel={id} className="size-4" />
              <span className="sr-only">{MESSAGING_CHANNEL_LABELS[id]}</span>
            </span>
          ))}
        </span>
      )}
      {source(Laptop, "Handoff from a local coding agent")}
      {source(Share2, "Other agents")}
    </div>
  );
}
