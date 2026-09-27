"use client";

import {
  BUILT_IN_AGENT_IDS,
  type OpenAppaPolicyTargetKind,
  type Permissions,
} from "@archestra/shared";
import Link from "next/link";
import { Button, type ButtonProps } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { useChatAgents } from "@/lib/agent.query";
import {
  type OpenAppaLaunchPromptKey,
  resolveOpenAppaLaunchPrompt,
} from "@/lib/openappa-chat-prompts";
import { openAppaChatHref } from "@/lib/openappa-routes";

export function OpenAppaChatButton({
  promptKey,
  target,
  children,
  permissions,
  ...props
}: Omit<ButtonProps, "asChild"> & {
  permissions?: Permissions;
  promptKey: OpenAppaLaunchPromptKey;
  target?: { kind: OpenAppaPolicyTargetKind; id: string; name: string };
}) {
  const agents = useChatAgents();
  const agent = agents.data?.find(
    (candidate) =>
      candidate.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
  );
  const prompt = resolveOpenAppaLaunchPrompt(promptKey, target);

  const canLaunch = !!agent && !!prompt;
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
  const content = canLaunch ? (
    <Link href={openAppaChatHref(agent.id, prompt)}>{children}</Link>
  ) : (
    children
  );

  return permissions ? (
    <PermissionButton {...buttonProps} permissions={permissions}>
      {content}
    </PermissionButton>
  ) : (
    <Button {...buttonProps}>{content}</Button>
  );
}
