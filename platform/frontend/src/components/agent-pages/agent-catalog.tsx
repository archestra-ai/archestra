import {
  type AgentCatalogId,
  getAgentCatalogImages,
  getDefaultAgentRuntimeImage,
  type SubscriptionCredentialKind,
} from "@archestra/shared";
import { Bot, Network } from "lucide-react";
import Image from "next/image";
import type { AgentFormInitialValues } from "@/components/agent-form";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { ProviderIcon } from "@/components/provider-icon";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

export interface AgentCatalogTemplate {
  id: AgentCatalogId;
  name: string;
  description: string;
  icon: string | null;
  initialValues: AgentFormInitialValues;
}

/**
 * Shared by the catalog card and the runtime pill. `archestra` is absent: its
 * name is composed from the app name.
 */
export const AGENT_CATALOG_TEMPLATE_NAMES: Record<
  Exclude<AgentCatalogId, "archestra">,
  string
> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

export function getAgentCatalogTemplates(
  archestraImage: string,
  // white-label-ok: test/helper fallback only; shipped UI always passes useAppName().
  appName = "Archestra",
): readonly AgentCatalogTemplate[] {
  const images = getAgentCatalogImages(archestraImage);
  return [
    template({
      id: "claude-code",
      name: AGENT_CATALOG_TEMPLATE_NAMES["claude-code"],
      icon: "/model-logos/anthropic.svg",
      description: `Anthropic's coding agent with personal Claude sign-in or provider billing, connected to the ${appName} MCP gateway.`,
      platformName: appName,
      image: images["claude-code"],
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
      steerMode: "tmux_keys",
    }),
    template({
      id: "codex",
      name: AGENT_CATALOG_TEMPLATE_NAMES.codex,
      icon: "/model-logos/openai.svg",
      description: `OpenAI's coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.codex,
      command: ["archestra-codex"],
      inferenceProtocol: "openai_responses",
      steerMode: "tmux_keys",
      requiredSubscriptionKind: "chatgpt",
    }),
    template({
      id: "opencode",
      name: AGENT_CATALOG_TEMPLATE_NAMES.opencode,
      icon: "/agent-logos/opencode.svg",
      description: `The open source coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: images.opencode,
      command: ["archestra-opencode"],
      inferenceProtocol: "openai_responses",
      steerMode: "tmux_keys",
    }),
    template({
      id: "hermes",
      name: AGENT_CATALOG_TEMPLATE_NAMES.hermes,
      icon: "/agent-logos/hermes.png",
      description: `The Hermes coding agent with its model and remote MCP tools supplied by ${appName}.`,
      platformName: appName,
      image: images.hermes,
      command: ["archestra-hermes"],
      inferenceProtocol: "openai_chat",
      steerMode: "tmux_keys",
    }),
    template({
      id: "openclaw",
      name: AGENT_CATALOG_TEMPLATE_NAMES.openclaw,
      icon: "/agent-logos/openclaw.svg",
      description: `OpenClaw in an isolated task pod, with inference and MCP access kept behind ${appName}.`,
      platformName: appName,
      image: images.openclaw,
      command: ["archestra-openclaw"],
      inferenceProtocol: "openai_chat",
      steerMode: "tmux_keys",
    }),
  ] as const;
}

export function AgentCatalog({
  canAddExternalAgent,
  canCreateAgent,
  onStartFromScratch,
  onAddExternalAgent,
  onSelect,
  showPopularAgents,
}: {
  canAddExternalAgent: boolean;
  canCreateAgent: boolean;
  onStartFromScratch: () => void;
  onAddExternalAgent: () => void;
  onSelect: (template: AgentCatalogTemplate) => void;
  showPopularAgents: boolean;
}) {
  const configuredImage = useFeature("agentRuntimeBaseImage");
  const appName = useAppName();
  const templates = getAgentCatalogTemplates(
    typeof configuredImage === "string"
      ? configuredImage
      : getDefaultAgentRuntimeImage("latest"),
    appName,
  );
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h2 className="text-base font-semibold">Create your own</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CatalogSourceCard
            icon={<span className="text-xl">✦</span>}
            title="Start from scratch"
            description="Build an Agent with the existing setup wizard and choose every setting yourself."
            onClick={onStartFromScratch}
            disabled={!canCreateAgent}
            disabledReason="Requires permission to create agents."
          />
        </div>
      </div>

      {showPopularAgents ? (
        <div className="space-y-3">
          <h2 className="text-base font-semibold">Popular agents</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((item) => (
              <CatalogSourceCard
                key={item.id}
                icon={<CatalogAgentIcon id={item.id} />}
                title={item.name}
                description={item.description}
                onClick={() => onSelect(item)}
                disabled={!canCreateAgent}
                disabledReason="Requires permission to create agents."
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-base font-semibold">External agents</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CatalogSourceCard
            icon={<Network className="size-5" />}
            title="Connect via A2A"
            description="Connect an A2A-compatible agent that your agents can use only as a subagent."
            onClick={onAddExternalAgent}
            disabled={!canAddExternalAgent}
            disabledReason="Requires permission to view agents and update agent settings."
          />
        </div>
      </div>
    </div>
  );
}

export function CatalogAgentIcon({
  id,
  appIconLogo = null,
  size = 22,
}: {
  id: AgentCatalogId;
  appIconLogo?: string | null;
  size?: number;
}) {
  const box = { width: size, height: size };
  switch (id) {
    case "archestra":
      return appIconLogo ? (
        <Image
          src={appIconLogo}
          alt=""
          width={size}
          height={size}
          style={box}
          className="rounded-sm object-contain"
        />
      ) : (
        <Bot className="size-5" />
      );
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
  icon: string | null;
  platformName: string;
  image: string;
  command: string[] | null;
  inferenceProtocol: "openai_responses" | "openai_chat" | "anthropic";
  steerMode: "pipe" | "tmux_keys";
  requiredSubscriptionKind?: SubscriptionCredentialKind;
}): AgentCatalogTemplate {
  return {
    id: params.id,
    name: params.name,
    description: params.description,
    icon: params.icon,
    initialValues: {
      name: params.name,
      icon: params.icon,
      description: params.description,
      systemPrompt: `You are ${params.name}, an autonomous coding agent. Complete delegated tasks carefully, use the tools available through ${params.platformName}, verify your work, and report the concrete result.`,
      accessAllTools: true,
      requiredSubscriptionKind: params.requiredSubscriptionKind,
      runtime: {
        image: params.image,
        command: params.command,
        inferenceProtocol: params.inferenceProtocol,
        backend: "kubernetes",
        steerMode: params.steerMode,
        privileged: false,
        resources: null,
        environment: null,
        credentials: [],
        ...(params.id === "claude-code" && {
          claudeCode: { authentication: "subscription" as const },
        }),
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
      },
    },
  };
}
