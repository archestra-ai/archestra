"use client";

import {
  type Action,
  BUILT_IN_AGENT_IDS,
  type OpenAppaPolicyTargetKind,
  type Permissions,
} from "@archestra/shared";
import Link from "next/link";
import type { ButtonProps } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { useChatAgents } from "@/lib/agent.query";
import {
  type OpenAppaLaunchPromptKey,
  openAppaYellInvestigationPrompt,
  resolveOpenAppaLaunchPrompt,
} from "@/lib/openappa-chat-prompts";
import { openAppaChatHref } from "@/lib/openappa-routes";

type OpenAppaChatTarget = {
  kind: OpenAppaPolicyTargetKind;
  id: string;
  name: string;
};

export type OpenAppaChatSubject =
  | {
      kind: "prompt";
      promptKey: OpenAppaLaunchPromptKey;
      target?: OpenAppaChatTarget;
    }
  | { kind: "yell"; yellId: string };

export function OpenAppaChatButton({
  promptKey,
  target,
  children,
  permissions,
  ...props
}: Omit<ButtonProps, "asChild"> & {
  permissions?: Permissions;
  promptKey: OpenAppaLaunchPromptKey;
  target?: OpenAppaChatTarget;
}) {
  const {
    agents,
    href,
    permissions: launchPermissions,
  } = useOpenAppaChatLaunch({
    subject: { kind: "prompt", promptKey, target },
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
          : "OpenAPPA Configuration Agent is unavailable",
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
}: {
  subject: OpenAppaChatSubject;
  permissions?: Permissions;
}) {
  const agents = useChatAgents();
  const agent = agents.data?.find(
    (candidate) =>
      candidate.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
  );
  const prompt =
    subject.kind === "yell"
      ? openAppaYellInvestigationPrompt(subject.yellId)
      : resolveOpenAppaLaunchPrompt(subject.promptKey, subject.target);
  const target = subject.kind === "prompt" ? subject.target : undefined;

  const launchPermissions: Permissions = {
    ...permissions,
    chat: [
      ...new Set<Action>(["read", "create", ...(permissions?.chat ?? [])]),
    ],
    agent: [...new Set<Action>(["read", ...(permissions?.agent ?? [])])],
    skill: [...new Set<Action>(["read", ...(permissions?.skill ?? [])])],
    openappaPolicy: [
      ...new Set<Action>(["read", ...(permissions?.openappaPolicy ?? [])]),
    ],
    ...(target?.kind === "mcp_gateway" ? { mcpGateway: ["read"] } : {}),
    ...(target?.kind === "mcp_server" ? { mcpRegistry: ["read"] } : {}),
    ...(subject.kind === "yell" ? { openappaDiagnostics: ["read"] } : {}),
  };

  return {
    permissions: launchPermissions,
    agents,
    href: agent && prompt ? openAppaChatHref(agent.id, prompt) : null,
  };
}
