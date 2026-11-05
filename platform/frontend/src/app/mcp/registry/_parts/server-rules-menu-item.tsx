"use client";

import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import Link from "next/link";
import { AppaKeeperIcon } from "@/components/appa-keeper-icon";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useChatAgentBootstrap } from "@/lib/agent.query";
import { useFeature } from "@/lib/config/config.query";
import { resolveOpenAppaLaunchPrompt } from "@/lib/openappa-chat-prompts";
import { openAppaChatHref } from "@/lib/openappa-routes";

/**
 * For a server's editors: change its own Guardrails rules with the APPA
 * Keeper, which opens a pull request on the policy repository. It takes edit
 * access to the server, not a Guardrails permission, so it sits beside the
 * server's other edit actions.
 */
export function ServerRulesMenuItem({
  catalog,
}: {
  catalog: { id: string; name: string };
}) {
  const openappaEnabled = useFeature("openappaEnabled") === true;
  const agents = useChatAgentBootstrap(openappaEnabled);
  const keeper = agents.data?.find(
    (agent) =>
      agent.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
  );
  const prompt = resolveOpenAppaLaunchPrompt("editServerRules", {
    kind: "mcp_server",
    id: catalog.id,
    name: catalog.name,
  });
  if (!openappaEnabled || !keeper || !prompt) return null;
  return (
    <DropdownMenuItem asChild>
      <Link href={openAppaChatHref(keeper.id, prompt)}>
        <AppaKeeperIcon />
        Edit Guardrails rules
      </Link>
    </DropdownMenuItem>
  );
}
