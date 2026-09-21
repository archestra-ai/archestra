"use client";

import { InfoIcon, KeyRound } from "lucide-react";
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
  const helperText =
    missing.length > 1
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
      <InlineNotice className="mt-2">
        <KeyRound />
        <span className="font-medium">
          {missing.length === 1
            ? `${missing[0].label} is required`
            : `${missing.length} connections are required`}
        </span>
        <InlineNoticeText>{helperText}</InlineNoticeText>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-6 shrink-0 bg-background px-2 text-xs"
          onClick={() => setConnecting(true)}
        >
          Connect
        </Button>
      </InlineNotice>
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
