"use client";

import { InfoIcon, KeyRound, Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AgentRuntimeCredentialsDialog } from "@/components/agent-runtime-credentials-dialog";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";

type MissingCredential = {
  key: string;
  credentialId?: string;
  label: string;
  description?: string;
  canConnect?: boolean;
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
  const blocked = missing.filter((entry) => entry.canConnect === false);
  const connectable = missing.filter((entry) => entry.canConnect !== false);
  const helperText =
    connectable.length > 1
      ? "Set up the missing credentials to continue."
      : "Connect it once to use it with every compatible Agent.";

  if (incompatible) {
    return (
      <output
        aria-live="polite"
        className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
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
    return (
      <div className="mt-2">
        <ClaudeCodeAccount agentId={agentId} variant="compact" />
      </div>
    );
  }

  return (
    <>
      {blocked.length > 0 && (
        <InlineNotice className="mt-2">
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
        <InlineNotice className="mt-2">
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
    </>
  );
}
