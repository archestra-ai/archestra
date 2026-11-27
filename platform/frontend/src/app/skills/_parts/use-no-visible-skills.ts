import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useExternalMcpSkills,
  usePluginSkills,
  useSkillsPaginated,
} from "@/lib/skills/skill.query";

/**
 * Whether the viewer can see no skill at all: none of their own or shared with
 * them, none served by an MCP server, none that came with a plugin. That is
 * when the Skills list has nothing to list and opens the Add new skill page in
 * its place, and when that page introduces skills and has no list to go back
 * to.
 *
 * `isPending` is true until all three answers are in, and until it is known
 * whether the viewer may read plugins at all, so a page can hold what depends
 * on it instead of drawing one state and then the other.
 */
export function useNoVisibleSkills(): {
  isPending: boolean;
  hasNoSkills: boolean;
} {
  const pluginReadPermission = useHasPermissions({ plugin: ["read"] });
  const scopedCapabilities = useScopedCapabilities();
  // The same rule the Skills list uses to show plugin skills.
  const pluginSkillsEnabled =
    pluginReadPermission.data === true ||
    (scopedCapabilities.data?.some(
      (grant) => grant.resource === "plugin" && grant.action === "read",
    ) ??
      false);
  // Not yet known whether the viewer may read plugins, so not yet known
  // whether a skill that came with a plugin is theirs to see.
  const isPluginSkillsUndecided =
    !pluginSkillsEnabled &&
    (pluginReadPermission.isPending || scopedCapabilities.isPending);
  // One row is enough: only the total is read. No access filter, unlike the
  // list, which opens on "Mine · Shared with me".
  const standalone = useSkillsPaginated(
    { limit: 1, offset: 0, includeContent: false },
    { toastOnError: false },
  );
  // Asked only where skills from MCP servers are switched on, as the Skills
  // list does: with the feature off there are none to see.
  const mcpSkillsEnabled = useFeature("mcpGatewaySkillsEnabled") === true;
  const external = useExternalMcpSkills({ enabled: mcpSkillsEnabled });
  const plugin = usePluginSkills({ enabled: pluginSkillsEnabled });

  const isPending =
    isFirstLoad(standalone) ||
    (mcpSkillsEnabled && isFirstLoad(external)) ||
    isPluginSkillsUndecided ||
    (pluginSkillsEnabled && isFirstLoad(plugin));
  return {
    isPending,
    hasNoSkills:
      !isPending &&
      standalone.data?.pagination?.total === 0 &&
      // A list that was refused or failed shows the viewer none of its
      // skills, so it counts as empty here; only the viewer's own list has to
      // have answered.
      (!mcpSkillsEnabled || (external.data?.length ?? 0) === 0) &&
      (!pluginSkillsEnabled || (plugin.data?.length ?? 0) === 0),
  };
}

function isFirstLoad(query: { isPending: boolean; isFetching: boolean }) {
  return query.isPending && query.isFetching;
}
