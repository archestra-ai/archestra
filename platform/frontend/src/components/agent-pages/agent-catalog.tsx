import { Bot, Shell, Sparkles } from "lucide-react";
import type { AgentFormInitialValues } from "@/components/agent-form";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { ProviderIcon } from "@/components/provider-icon";
import { Badge } from "@/components/ui/badge";
import { useFeature } from "@/lib/config/config.query";

export interface AgentCatalogTemplate {
  id: "archestra" | "claude-code" | "codex" | "hermes" | "openclaw";
  name: string;
  description: string;
  icon: string;
  initialValues: AgentFormInitialValues;
}

export function getAgentCatalogTemplates(
  archestraImage: string,
): readonly AgentCatalogTemplate[] {
  return [
    template({
      id: "archestra",
      name: "Archestra Agent",
      icon: "🏛️",
      description:
        "Archestra's lightweight agent loop with model inference and MCP tools managed by the platform.",
      image: image(archestraImage, "archestra"),
      command: null,
      inferenceProtocol: "openai_responses",
      steerMode: "pipe",
    }),
    template({
      id: "claude-code",
      name: "Claude Code",
      icon: "🟠",
      description:
        "Anthropic's coding agent, preconfigured to use the Archestra LLM proxy and MCP gateway.",
      image: image(archestraImage, "claude-code"),
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
      steerMode: "tmux_keys",
    }),
    template({
      id: "codex",
      name: "Codex",
      icon: "🟢",
      description:
        "OpenAI's coding agent, preconfigured to use the Archestra LLM proxy and MCP gateway.",
      image: image(archestraImage, "codex"),
      command: ["archestra-codex"],
      inferenceProtocol: "openai_responses",
      steerMode: "tmux_keys",
    }),
    template({
      id: "hermes",
      name: "Hermes",
      icon: "⚕️",
      description:
        "The Hermes coding agent with its model and remote MCP tools supplied by Archestra.",
      image: image(archestraImage, "hermes"),
      command: ["archestra-hermes"],
      inferenceProtocol: "openai_chat",
      steerMode: "tmux_keys",
    }),
    template({
      id: "openclaw",
      name: "OpenClaw",
      icon: "🦞",
      description:
        "OpenClaw in an isolated task pod, with inference and MCP access kept behind Archestra.",
      image: image(archestraImage, "openclaw"),
      command: ["archestra-openclaw"],
      inferenceProtocol: "openai_responses",
      steerMode: "tmux_keys",
    }),
  ] as const;
}

export function AgentCatalog({
  onStartFromScratch,
  onSelect,
}: {
  onStartFromScratch: () => void;
  onSelect: (template: AgentCatalogTemplate) => void;
}) {
  const configuredImage = useFeature("agentBackgroundExecutionBaseImage");
  const templates = getAgentCatalogTemplates(
    typeof configuredImage === "string"
      ? configuredImage
      : DEFAULT_ARCHESTRA_AGENT_IMAGE,
  );
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="space-y-3">
        <h2 className="text-base font-semibold">Create your own</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CatalogSourceCard
            icon={<span className="text-xl">✦</span>}
            title="Start from scratch"
            description="Build an Agent with the existing setup wizard and choose every setting yourself."
            onClick={onStartFromScratch}
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Popular agents</h2>
          <Badge variant="secondary">{templates.length}</Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((item) => (
            <CatalogSourceCard
              key={item.id}
              icon={<CatalogAgentIcon id={item.id} />}
              title={item.name}
              description={item.description}
              badge={
                item.id === "archestra" ? (
                  <Badge variant="outline">Built in</Badge>
                ) : undefined
              }
              onClick={() => onSelect(item)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CatalogAgentIcon({ id }: { id: AgentCatalogTemplate["id"] }) {
  switch (id) {
    case "archestra":
      return <ProviderIcon provider="archestra" size={22} />;
    case "claude-code":
      return <ProviderIcon provider="anthropic" size={22} />;
    case "codex":
      return <ProviderIcon provider="openai" size={22} />;
    case "hermes":
      return <Sparkles className="size-5" />;
    case "openclaw":
      return <Shell className="size-5" />;
    default:
      return <Bot className="size-5" />;
  }
}

function template(params: {
  id: AgentCatalogTemplate["id"];
  name: string;
  description: string;
  icon: string;
  image: string;
  command: string[] | null;
  inferenceProtocol: "openai_responses" | "openai_chat" | "anthropic";
  steerMode: "pipe" | "tmux_keys";
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
      systemPrompt: `You are ${params.name}, an autonomous coding agent. Complete delegated tasks carefully, use the tools available through Archestra, verify your work, and report the concrete result.`,
      accessAllTools: true,
      backgroundExecution: {
        image: params.image,
        command: params.command,
        inferenceProtocol: params.inferenceProtocol,
        backend: "kubernetes",
        steerMode: params.steerMode,
        privileged: false,
        resources: null,
        environment: null,
        credentials: [
          {
            key: "GITHUB_TOKEN",
            scope: "per_user",
            label: "GitHub token",
            description:
              "A token that can clone repositories, push branches, and open pull requests.",
            required: true,
          },
        ],
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
      },
    },
  };
}

function image(
  archestraImage: string,
  name: AgentCatalogTemplate["id"],
): string {
  if (/agent-archestra(?=:[^/]+$|$)/.test(archestraImage)) {
    return archestraImage.replace(
      /agent-archestra(?=:[^/]+$|$)/,
      `agent-${name}`,
    );
  }
  return name === "archestra"
    ? archestraImage
    : DEFAULT_ARCHESTRA_AGENT_IMAGE.replace("agent-archestra", `agent-${name}`);
}

const DEFAULT_ARCHESTRA_AGENT_IMAGE =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-archestra:latest";
