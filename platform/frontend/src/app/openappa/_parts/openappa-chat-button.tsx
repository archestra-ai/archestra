"use client";

import {
  type Action,
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
  type Permissions,
} from "@archestra/shared";
import Link from "next/link";
import type { ButtonProps } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { useChatAgentBootstrap } from "@/lib/agent.query";
import {
  type OpenAppaBatteryChange,
  type OpenAppaLaunchPromptKey,
  type OpenAppaLaunchTarget,
  openAppaYellInvestigationPrompt,
  resolveOpenAppaBatteryChangesPrompt,
  resolveOpenAppaBatteryPrompt,
  resolveOpenAppaLaunchPrompt,
} from "@/lib/openappa-chat-prompts";
import { openAppaChatHref } from "@/lib/openappa-routes";

export type OpenAppaChatSubject =
  | {
      kind: "prompt";
      promptKey: OpenAppaLaunchPromptKey;
      target?: OpenAppaLaunchTarget;
    }
  | { kind: "yell"; yellId: string }
  /** One battery change, which the agent opens as a pull request. */
  | { kind: "battery"; change: OpenAppaBatteryChange }
  /** The changes a battery's dialog saves together, asked for as one. */
  | {
      kind: "batteryChanges";
      changes: OpenAppaBatteryChange[];
      /** Asked by a server's editor who may not update guardrails. */
      serverEditor?: boolean;
    }
  /** Sends nothing: the chat opens on the agent's suggested prompts. */
  | { kind: "suggestedPrompts" };

export function OpenAppaChatButton({
  promptKey,
  target,
  batteryChange,
  children,
  permissions,
  ...props
}: Omit<ButtonProps, "asChild"> & {
  permissions?: Permissions;
  /** Omit to open the chat on the agent's suggested prompts. */
  promptKey?: OpenAppaLaunchPromptKey;
  target?: OpenAppaLaunchTarget;
  /** Ask for one battery change instead of a keyed prompt. */
  batteryChange?: OpenAppaBatteryChange;
}) {
  const {
    agents,
    href,
    permissions: launchPermissions,
  } = useOpenAppaChatLaunch({
    subject: batteryChange
      ? { kind: "battery", change: batteryChange }
      : promptKey
        ? { kind: "prompt", promptKey, target }
        : { kind: "suggestedPrompts" },
    permissions,
  });
  const canLaunch = !!href;
  const buttonProps: ButtonProps = canLaunch
    ? { ...props, asChild: true }
    : {
        ...props,
        disabled: !agents.isError,
        title: agents.isError
          ? "Could not load the chat agent. Click to retry."
          : `${BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG} is unavailable`,
        onClick: (event) => {
          props.onClick?.(event);
          void agents.refetch();
        },
      };
  const content = canLaunch ? <Link href={href}>{children}</Link> : children;

  return (
    <PermissionButton {...buttonProps} permissions={launchPermissions}>
      {content}
    </PermissionButton>
  );
}

export function useOpenAppaChatLaunch({
  subject,
  permissions,
  enabled = true,
}: {
  subject: OpenAppaChatSubject;
  permissions?: Permissions;
  /** False skips looking up the agent, for a caller that may not launch. */
  enabled?: boolean;
}) {
  const agents = useChatAgentBootstrap(enabled);
  const agent = agents.data?.find(
    (candidate) =>
      candidate.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
  );
  const prompt =
    subject.kind === "yell"
      ? openAppaYellInvestigationPrompt(subject.yellId)
      : subject.kind === "prompt"
        ? resolveOpenAppaLaunchPrompt(subject.promptKey, subject.target)
        : subject.kind === "battery"
          ? resolveOpenAppaBatteryPrompt(subject.change)
          : subject.kind === "batteryChanges"
            ? resolveOpenAppaBatteryChangesPrompt(subject.changes, {
                serverEditor: subject.serverEditor,
              })
            : undefined;
  const target = subject.kind === "prompt" ? subject.target : undefined;
  const batteryServer =
    (subject.kind === "battery" && "server" in subject.change) ||
    (subject.kind === "batteryChanges" &&
      subject.changes.some((change) => "server" in change));

  const launchPermissions: Permissions = {
    ...permissions,
    chat: [
      ...new Set<Action>(["read", "create", ...(permissions?.chat ?? [])]),
    ],
    agent: [...new Set<Action>(["read", ...(permissions?.agent ?? [])])],
    skill: [...new Set<Action>(["read", ...(permissions?.skill ?? [])])],
    guardrailsPolicy: [
      ...new Set<Action>(["read", ...(permissions?.guardrailsPolicy ?? [])]),
    ],
    ...(target?.kind === "mcp_gateway" ? { mcpGateway: ["read"] } : {}),
    ...(target?.kind === "mcp_server" || batteryServer
      ? { mcpRegistry: ["read"] }
      : {}),
    ...(subject.kind === "yell" ? { guardrailsLog: ["read"] } : {}),
  };

  return {
    permissions: launchPermissions,
    agents,
    href:
      agent && (prompt || subject.kind === "suggestedPrompts")
        ? openAppaChatHref(agent.id, prompt)
        : null,
  };
}
