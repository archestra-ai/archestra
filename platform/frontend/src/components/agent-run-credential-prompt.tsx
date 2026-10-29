"use client";

import { AlertTriangle, InfoIcon, KeyRound, Lock } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, useState } from "react";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { getApiRefusal } from "@/lib/utils/api";
import { lazyComponent } from "@/lib/utils/preloadable-lazy";

// The credentials form loads when someone starts connecting.
const AgentRuntimeCredentialsDialog = lazyComponent<
  ComponentProps<
    typeof import("@/components/agent-runtime-credentials-dialog").AgentRuntimeCredentialsDialog
  >
>(() =>
  import("@/components/agent-runtime-credentials-dialog").then(
    (m) => m.AgentRuntimeCredentialsDialog,
  ),
);

type MissingCredential = {
  key: string;
  credentialId?: string;
  label: string;
  description?: string;
  canConnect?: boolean;
  adminOnly?: boolean;
};

type CredentialDeclaration = MissingCredential & {
  scope: "shared" | "per_user";
  required: boolean;
};

export function AgentRuntimeCredentialPrompt({
  agentId,
  missing,
  declarations,
  incompatible,
  onConnected,
}: {
  agentId: string;
  missing: MissingCredential[];
  declarations: CredentialDeclaration[];
  incompatible?: string | null;
  onConnected: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  // Credentials the person may not use: no value of theirs can fix these, so
  // they get a plain "ask an admin" notice rather than a Connect button.
  const adminOnly = missing.filter((entry) => entry.adminOnly);
  const blocked = missing.filter(
    (entry) => entry.canConnect === false && !entry.adminOnly,
  );
  const connectable = missing.filter((entry) => entry.canConnect !== false);
  const helperText =
    connectable.length > 1
      ? "Set up the missing credentials to continue."
      : "Connect it once to use it with every compatible Agent.";

  // Nothing this person connects lets them run it, so the other prompts
  // would only send them on an errand.
  if (adminOnly.length > 0) {
    return (
      <InlineNotice>
        <Lock />
        <span className="font-medium">Only admins can run this agent</span>
        <InlineNoticeText>
          {adminOnlyDescription(adminOnly.map(({ label }) => label))}
        </InlineNoticeText>
      </InlineNotice>
    );
  }

  if (incompatible) {
    return (
      <output
        aria-live="polite"
        className="flex items-start gap-1.5 text-xs text-muted-foreground"
      >
        <InfoIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span>
          This model is not supported by the runtime.{" "}
          <Link
            href={`/agents/${agentId}`}
            className="whitespace-nowrap rounded-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Agent details
          </Link>
        </span>
      </output>
    );
  }

  if (missing.length === 1 && missing[0].key === "CLAUDE_CODE_ACCOUNT") {
    return <ClaudeCodeAccount agentId={agentId} variant="compact" />;
  }

  return (
    <div className="space-y-2">
      {blocked.length > 0 && (
        <InlineNotice>
          <Lock />
          <span className="font-medium">
            {blocked.length === 1
              ? `You don't have access to ${blocked[0].label}`
              : `You don't have access to ${blocked.length} credentials this Agent needs`}
          </span>
          <InlineNoticeText>
            {blocked.length === 1
              ? "This Agent needs it to run. Ask an admin to share it with you."
              : `${blocked.map(({ label }) => label).join(", ")}. Ask an admin to share them with you.`}
          </InlineNoticeText>
        </InlineNotice>
      )}
      {connectable.length > 0 && (
        <InlineNotice>
          <KeyRound />
          <span className="font-medium">
            {connectable.length === 1
              ? `${connectable[0].label} is required`
              : `${connectable.length} connections are required`}
          </span>
          <InlineNoticeText>{helperText}</InlineNoticeText>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ml-auto shrink-0 bg-background"
            onClick={() => setConnecting(true)}
          >
            Connect
          </Button>
        </InlineNotice>
      )}
      {connecting && (
        <AgentRuntimeCredentialsDialog
          agentId={agentId}
          declarations={declarations}
          canEditAgent={false}
          onClose={() => {
            setConnecting(false);
            onConnected();
          }}
        />
      )}
    </div>
  );
}

/** What to tell someone an organization credential keeps from running an agent. */
export function adminOnlyDescription(labels: string[]): string {
  return `It uses ${formatList(labels)} from your organization. Ask an admin to run it for you or change its setup.`;
}

/**
 * The agent's setup check failed, so Send stays off. Says so where the reader
 * is looking instead of only in the disabled button's tooltip.
 */
export function AgentRuntimePreflightError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const refusal = getApiRefusal(error);
  return (
    <InlineNotice variant="error">
      <AlertTriangle />
      <span className="font-medium">
        Can&apos;t check this agent&apos;s setup
      </span>
      <InlineNoticeText>
        {refusal === "forbidden"
          ? "You don't have access to it. Ask an admin if you need it."
          : refusal === "signed-out"
            ? "Your session ended. Sign in again to continue."
            : "Check your internet connection and try again."}
      </InlineNoticeText>
      {refusal !== "forbidden" && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto shrink-0 bg-background"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </InlineNotice>
  );
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
