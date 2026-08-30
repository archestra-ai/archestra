import type { SubscriptionCredentialKind } from "@archestra/shared";
import { Bot } from "lucide-react";
import Image from "next/image";
import type { AgentFormInitialValues } from "@/components/agent-form";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { ProviderIcon } from "@/components/provider-icon";
import { Badge } from "@/components/ui/badge";
import appConfig from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import {
  DEFAULT_APP_LOGO,
  useAppIconLogo,
  useAppName,
} from "@/lib/hooks/use-app-name";

export interface AgentCatalogTemplate {
  id: "archestra" | "claude-code" | "codex" | "hermes" | "openclaw";
  name: string;
  description: string;
  icon: string | null;
  initialValues: AgentFormInitialValues;
}

export function getAgentCatalogTemplates(
  archestraImage: string,
  // white-label-ok: test/helper fallback only; shipped UI always passes useAppName().
  appName = "Archestra",
  appIconLogo: string | null = "/logo-icon.svg",
): readonly AgentCatalogTemplate[] {
  return [
    template({
      id: "archestra",
      name: `${appName} Agent`,
      icon: appIconLogo,
      description: `${appName}'s lightweight agent loop with model inference and MCP tools managed by the platform.`,
      platformName: appName,
      image: image(archestraImage, "archestra"),
      command: null,
      inferenceProtocol: "openai_responses",
      steerMode: "pipe",
    }),
    template({
      id: "claude-code",
      name: "Claude Code",
      icon: "/model-logos/anthropic.svg",
      description: `Anthropic's coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: image(archestraImage, "claude-code"),
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
      steerMode: "tmux_keys",
      additionalCredentials: [
        {
          key: "CLAUDE_CODE_OAUTH_TOKEN",
          credentialId: "claude-code",
          scope: "per_user",
          label: "Claude Code subscription token",
          description:
            "A personal Claude subscription token used only by Claude Code background tasks.",
          required: true,
        },
      ],
    }),
    template({
      id: "codex",
      name: "Codex",
      icon: "/model-logos/openai.svg",
      description: `OpenAI's coding agent, preconfigured to use the ${appName} LLM proxy and MCP gateway.`,
      platformName: appName,
      image: image(archestraImage, "codex"),
      command: ["archestra-codex"],
      inferenceProtocol: "openai_responses",
      steerMode: "tmux_keys",
      requiredSubscriptionKind: "chatgpt",
    }),
    template({
      id: "hermes",
      name: "Hermes",
      icon: "/agent-logos/hermes.png",
      description: `The Hermes coding agent with its model and remote MCP tools supplied by ${appName}.`,
      platformName: appName,
      image: image(archestraImage, "hermes"),
      command: ["archestra-hermes"],
      inferenceProtocol: "openai_chat",
      steerMode: "tmux_keys",
    }),
    template({
      id: "openclaw",
      name: "OpenClaw",
      icon: "/agent-logos/openclaw.svg",
      description: `OpenClaw in an isolated task pod, with inference and MCP access kept behind ${appName}.`,
      platformName: appName,
      image: image(archestraImage, "openclaw"),
      command: ["archestra-openclaw"],
      inferenceProtocol: "openai_chat",
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
  const appName = useAppName();
  const resolvedAppIconLogo = useAppIconLogo();
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const appIconLogo =
    appConfig.enterpriseFeatures.fullWhiteLabeling &&
    resolvedAppIconLogo === DEFAULT_APP_LOGO
      ? null
      : resolvedAppIconLogo;
  // SPDX-SnippetEnd
  const templates = getAgentCatalogTemplates(
    typeof configuredImage === "string"
      ? configuredImage
      : DEFAULT_ARCHESTRA_AGENT_IMAGE,
    appName,
    appIconLogo,
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
        <h2 className="text-base font-semibold">Popular agents</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((item) => (
            <CatalogSourceCard
              key={item.id}
              icon={<CatalogAgentIcon id={item.id} appIconLogo={appIconLogo} />}
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

function CatalogAgentIcon({
  id,
  appIconLogo,
}: {
  id: AgentCatalogTemplate["id"];
  appIconLogo: string | null;
}) {
  switch (id) {
    case "archestra":
      return appIconLogo ? (
        <Image
          src={appIconLogo}
          alt=""
          width={22}
          height={22}
          className="size-[22px] rounded-sm object-contain"
        />
      ) : (
        <Bot className="size-5" />
      );
    case "claude-code":
      return <ProviderIcon provider="anthropic" size={22} />;
    case "codex":
      return <ProviderIcon provider="openai" size={22} />;
    case "hermes":
      return (
        <Image
          src="/agent-logos/hermes.png"
          alt=""
          width={30}
          height={30}
          className="size-[30px] rounded-md object-contain"
        />
      );
    case "openclaw":
      return (
        <Image
          src="/agent-logos/openclaw.svg"
          alt=""
          width={22}
          height={22}
          className="size-[22px] object-contain"
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
  additionalCredentials?: NonNullable<
    NonNullable<AgentFormInitialValues["backgroundExecution"]>["credentials"]
  >;
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
            credentialId: "github",
            scope: "per_user",
            label: "GitHub token",
            description:
              "Used to clone repositories and push changes from background tasks.",
            required: false,
          },
          ...(params.additionalCredentials ?? []),
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
