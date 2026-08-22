import type { Permissions } from "@archestra/shared";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";
import { pluginEditHref } from "./plugin-page-config";

export type PluginActionId = "install" | "edit" | "updates" | "delete";

export interface PluginActionDefinition {
  id: PluginActionId;
  label: string;
  permissions: Permissions;
  href?: string;
}

/** Canonical active-Plugin actions for table rows and detail headers. */
export function getPluginActionModel(params: {
  pluginId: string;
  hasPendingUpdate?: boolean;
}): PluginActionDefinition[] {
  return [
    {
      id: "install",
      label: "Install",
      permissions: { plugin: ["read", "admin"] },
    },
    {
      id: "edit",
      label: ACTION_LABEL.edit,
      permissions: { plugin: ["update", "admin"] },
      href: pluginEditHref(params.pluginId),
    },
    {
      id: "updates",
      label: params.hasPendingUpdate ? "Review update" : "Updates",
      permissions: { plugin: ["update", "admin"] },
    },
    {
      id: "delete",
      label: ACTION_LABEL.delete,
      permissions: { plugin: ["delete", "admin"] },
    },
  ];
}

export function pluginAction(
  model: PluginActionDefinition[],
  id: PluginActionId,
) {
  const definition = model.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing Plugin action definition: ${id}`);
  return definition;
}

export function pluginActionHref(definition: PluginActionDefinition): string {
  if (!definition.href) {
    throw new Error(`Plugin action has no destination: ${definition.id}`);
  }
  return definition.href;
}
