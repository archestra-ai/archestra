import type { Permissions } from "@archestra/shared";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";
import { pluginEditHref } from "./plugin-page-config";

export type PluginActionId = "install" | "edit" | "updates" | "delete";

export interface PluginActionDefinition {
  id: PluginActionId;
  label: string;
  permissions: Permissions;
  /** The plugin itself: each action is a grant on that one plugin. */
  permissionScope: string;
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
      // `use` is a grant action rather than a role action, so the
      // role-permission type does not list it.
      permissions: { plugin: ["use"] as string[] } as Permissions,
      permissionScope: params.pluginId,
    },
    {
      id: "edit",
      label: ACTION_LABEL.edit,
      permissions: { plugin: ["update"] },
      permissionScope: params.pluginId,
      href: pluginEditHref(params.pluginId),
    },
    {
      id: "updates",
      label: params.hasPendingUpdate ? "Review update" : "Updates",
      permissions: { plugin: ["update"] },
      permissionScope: params.pluginId,
    },
    {
      id: "delete",
      label: ACTION_LABEL.delete,
      permissions: { plugin: ["delete"] },
      permissionScope: params.pluginId,
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
