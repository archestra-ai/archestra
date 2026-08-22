import {
  type AgentType,
  getResourceForAgentType,
  type Permissions,
} from "@archestra/shared";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";
import {
  type AgentPageKind,
  agentDetailHref,
  agentEditHref,
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
}

/**
 * Canonical actions shared by agent-family list rows and detail headers.
 * Renderers choose buttons versus menu items, but labels, order, routes,
 * visibility, and the stored record's permission resource live here.
 */
export function getAgentActionModel({
  kind,
  agent,
}: {
  kind: AgentPageKind;
  agent: {
    id: string;
    agentType: AgentType;
    builtIn?: boolean | null;
  };
}): AgentActionDefinition[] {
  const builtIn = !!agent.builtIn;
  const resource = getResourceForAgentType(agent.agentType);

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
      label: ACTION_LABEL.chat,
      visible: kind === "agent" && !builtIn,
      href: `/chat/new?agent_id=${agent.id}`,
    },
    {
      id: "edit",
      label: ACTION_LABEL.edit,
      visible: true,
      permissions: permission(
        resource,
        builtIn ? ["update", "admin"] : "update",
      ),
      href: agentEditHref(kind, agent.id),
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
