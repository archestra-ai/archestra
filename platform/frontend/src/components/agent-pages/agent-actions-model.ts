import {
  type AgentType,
  getResourceForAgentType,
  type Permissions,
} from "@archestra/shared";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";
import {
  type AgentPageKind,
  agentConfigureHref,
  agentDetailHref,
} from "./agent-page-config";

export type AgentActionId =
  | "connect"
  | "chat"
  | "edit"
  | "clone"
  | "export"
  | "history"
  | "convert"
  | "delete";

export interface AgentActionDefinition {
  id: AgentActionId;
  label: string;
  visible: boolean;
  permissions?: Permissions;
  href?: string;
  /**
   * Chat only: the composer it opens starts a run in the agent's dedicated
   * runtime instead of a conversation. Renderers swap the glyph on it, and
   * the label already says "Start run", so the row and the detail header
   * cannot disagree about what the click does.
   */
  startsRun?: boolean;
}

/**
 * Canonical actions shared by agent-family list rows and detail headers.
 * Renderers choose buttons versus menu items, but labels, order, routes,
 * visibility, and the stored record's permission resource live here.
 */
export function getAgentActionModel({
  kind,
  agent,
  agentRuntimeEnabled = false,
}: {
  kind: AgentPageKind;
  agent: {
    id: string;
    agentType: AgentType;
    builtIn?: boolean | null;
    runtime?: unknown | null;
  };
  /**
   * The deployment's `agentRuntime` feature. A stored runtime config only
   * changes what Chat does while the feature is on — the composer applies the
   * same gate — so an agent configured on a deployment that later turned the
   * runtime off goes back to offering a plain Chat.
   */
  agentRuntimeEnabled?: boolean;
}): AgentActionDefinition[] {
  const builtIn = !!agent.builtIn;
  const resource = getResourceForAgentType(agent.agentType);
  const startsRun =
    agentRuntimeEnabled && kind === "agent" && agent.runtime != null;

  return [
    {
      id: "connect",
      label: ACTION_LABEL.connect,
      visible: !builtIn,
      permissions: permission(resource, "read"),
      href: agentDetailHref(kind, agent.id, "connect"),
    },
    {
      id: "chat",
      label: startsRun ? ACTION_LABEL.startRun : ACTION_LABEL.chat,
      visible: kind === "agent" && !builtIn,
      href: `/chat/new?agent_id=${agent.id}`,
      startsRun,
    },
    {
      id: "edit",
      label: ACTION_LABEL.edit,
      visible: true,
      permissions: permission(
        resource,
        builtIn ? ["update", "admin"] : "update",
      ),
      href: agentConfigureHref(kind, agent.id),
    },
    {
      id: "clone",
      label: ACTION_LABEL.clone,
      visible: true,
      permissions: permission(resource, "create"),
    },
    {
      id: "export",
      label: "Export",
      visible: kind === "agent",
      permissions: permission(resource, "read"),
    },
    {
      id: "history",
      label: ACTION_LABEL.versionHistory,
      visible: true,
      permissions: permission(resource, "read"),
    },
    {
      id: "convert",
      label: "Convert to skill",
      visible: kind === "agent",
      permissions: { skill: ["create"] },
    },
    {
      id: "delete",
      label: ACTION_LABEL.delete,
      visible: true,
      permissions: permission(resource, "delete"),
    },
  ];
}

export function agentAction(model: AgentActionDefinition[], id: AgentActionId) {
  const definition = model.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing agent action definition: ${id}`);
  return definition;
}

export function agentActionHref(definition: AgentActionDefinition): string {
  if (!definition.href) {
    throw new Error(`Agent action has no destination: ${definition.id}`);
  }
  return definition.href;
}

function permission(
  resource: ReturnType<typeof getResourceForAgentType>,
  action:
    | "create"
    | "read"
    | "update"
    | "delete"
    | readonly ["update", "admin"],
): Permissions {
  return {
    [resource]: Array.isArray(action) ? action : [action],
  } as Permissions;
}
