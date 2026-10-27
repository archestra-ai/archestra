import { type AgentCatalogId, APPA_KEEPER_AGENT_ICON } from "@archestra/shared";
import { siAnthropic, siGithub, siGitlab } from "simple-icons";

/** Values the shared Agent icon controls render as images rather than emoji. */
export function isAgentImageIcon(
  icon: string | null | undefined,
): icon is string {
  return (
    icon?.startsWith("data:image/") === true || icon?.startsWith("/") === true
  );
}

/**
 * The icon an agent catalog template saves on the agents it creates. Agent
 * icons draw these values as the template's Connect page mark, not as the
 * file they name, so stored agents and the Connect page show the same logo.
 * Agents keep the value they were saved with, so never change a value here.
 */
export const CATALOG_AGENT_ICONS: Record<AgentCatalogId, string> = {
  "claude-code": "/model-logos/anthropic.svg",
  codex: "/model-logos/openai.svg",
  opencode: "/agent-logos/opencode.svg",
  hermes: "/agent-logos/hermes.png",
  openclaw: "/agent-logos/openclaw.svg",
  grok: "/model-logos/grok.svg",
  kimi: "/agent-logos/kimi.svg",
};

const CATALOG_AGENT_ID_BY_ICON = new Map(
  Object.entries(CATALOG_AGENT_ICONS).map(
    ([id, icon]) => [icon, id as AgentCatalogId] as const,
  ),
);

/** The catalog template whose saved icon this is, if any. */
export function getCatalogAgentId(
  icon: string | null | undefined,
): AgentCatalogId | null {
  return icon ? (CATALOG_AGENT_ID_BY_ICON.get(icon) ?? null) : null;
}

export function getBuiltInServiceIconPath(
  icon: string | null | undefined,
): string | null {
  return icon && Object.hasOwn(BUILT_IN_SERVICE_ICON_PATHS, icon)
    ? BUILT_IN_SERVICE_ICON_PATHS[icon]
    : null;
}

export function isBuiltInServiceIcon(
  icon: string | null | undefined,
): icon is string {
  return (
    icon === "logo:openappa" ||
    icon === APPA_KEEPER_AGENT_ICON ||
    getBuiltInServiceIconPath(icon) !== null
  );
}

/**
 * Built-in vector service logos selectable via the "logo:<slug>" icon
 * convention (e.g. the GitHub App credential type). Not free-form: these are
 * the only slugs the shared icon controls know how to render as an SVG mark
 * rather than falling back to literal emoji text.
 */
const BUILT_IN_SERVICE_ICON_PATHS: Record<string, string> = {
  "logo:github": siGithub.path,
  "logo:gitlab": siGitlab.path,
  "logo:anthropic": siAnthropic.path,
};
