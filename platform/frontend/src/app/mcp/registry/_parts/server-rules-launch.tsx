"use client";

import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import Link from "next/link";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useChatAgentBootstrap } from "@/lib/agent.query";
import { useFeature } from "@/lib/config/config.query";
import { resolveOpenAppaLaunchPrompt } from "@/lib/openappa-chat-prompts";
import { useAppaSelfService } from "@/lib/openappa-github-sync.query";
import { openAppaChatHref } from "@/lib/openappa-routes";

export type ServerRulesCatalog = { id: string; name: string };

export const SERVER_RULES_LABEL = "Edit Guardrails rules";

/**
 * For a server's editors: change its own Guardrails rules with the APPA
 * Keeper, which opens a pull request on the policy repository. It takes edit
 * access to the server, not a Guardrails permission, so it sits beside the
 * server's other edit actions, on its page and on the setup wizard's last
 * step.
 */
export function ServerRulesButton({
  catalog,
  children,
  ...props
}: Omit<ButtonProps, "asChild"> & { catalog: ServerRulesCatalog }) {
  const href = useServerRulesHref(catalog);
  if (!href) return null;
  return (
    <Button {...props} asChild>
      <Link href={href}>{children}</Link>
    </Button>
  );
}

/**
 * The chat href for a server's rules, or null while self-service is off for
 * the organization or the Keeper is out of reach.
 */
export function useServerRulesHref(catalog: ServerRulesCatalog): string | null {
  const openappaEnabled = useFeature("openappaEnabled") === true;
  const selfService =
    useAppaSelfService(openappaEnabled).data?.enabled === true;
  const agents = useChatAgentBootstrap(openappaEnabled && selfService);
  const keeper = agents.data?.find(
    (agent) =>
      agent.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
  );
  const prompt = resolveOpenAppaLaunchPrompt("editServerRules", {
    kind: "mcp_server",
    id: catalog.id,
    name: catalog.name,
  });
  if (!openappaEnabled || !selfService || !keeper || !prompt) return null;
  return openAppaChatHref(keeper.id, prompt);
}
