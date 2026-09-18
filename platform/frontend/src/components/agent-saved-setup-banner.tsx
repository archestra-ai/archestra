"use client";

import Link from "next/link";
import { useState } from "react";
import { AgentRuntimeCredentialsDialog } from "@/components/agent-runtime-credentials-dialog";
import {
  AgentSetupBanner,
  type AgentSetupItem,
} from "@/components/agent-setup-banner";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/lib/agent.query";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";

export function AgentSavedSetupBanner({
  agentId,
  canEditAgent,
  showReady = false,
}: {
  agentId: string;
  canEditAgent: boolean;
  showReady?: boolean;
}) {
  const { data: agent } = useProfile(agentId);
  const runtime = agent?.runtime;
  const preflight = useAgentRuntimePreflight(agentId, !!runtime);
  const isCodex = runtime?.command?.[0] === "archestra-codex";
  const keyPermission = useHasPermissions({ llmProviderApiKey: ["read"] });
  const keys = useAvailableLlmProviderApiKeys({
    enabled: isCodex && keyPermission.data === true,
    includeKeyId: agent?.llmApiKeyId ?? undefined,
    toastOnError: false,
  });
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  if (!runtime) {
    return <AgentSetupBanner key={agentId} items={[]} showReady={showReady} />;
  }
  const failed = preflight.isError;
  const loading =
    preflight.isPending ||
    (isCodex &&
      (keyPermission.isPending || (keyPermission.data && keys.isPending)));
  if (failed) {
    return (
      <QueryLoadError
        title="Cannot check agent setup"
        onRetry={() => {
          void preflight.refetch();
          if (isCodex) void keys.refetch();
        }}
      />
    );
  }
  if (loading || !preflight.data) {
    return (
      <Alert>
        <AlertDescription>
          <span>Checking agent setup…</span>
        </AlertDescription>
      </Alert>
    );
  }
  const missing = [...preflight.data.missing, ...preflight.data.misconfigured];
  const items: AgentSetupItem[] = Array.from(
    new Map(missing.map((credential) => [credential.key, credential])).values(),
  ).map(({ key, label }) => ({
    id: key,
    label:
      key === "CLAUDE_CODE_ACCOUNT"
        ? "Connect your Claude account"
        : `Provide a value for ${label}, or connect ${label}`,
    status: "now",
    action:
      key === "CLAUDE_CODE_ACCOUNT" ? (
        <ClaudeCodeAccount agentId={agentId} variant="compact" />
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCredentialsOpen(true)}
        >
          Set up
        </Button>
      ),
  }));
  if (preflight.data.incompatible) {
    items.push({
      id: "model-incompatible",
      label: preflight.data.incompatible,
      status: "now",
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href={`/agents/${agentId}?section=general`}>Review model</Link>
        </Button>
      ),
    });
  }
  if (isCodex) {
    const selectedKey = keys.data?.find((key) => key.id === agent?.llmApiKeyId);
    const hasPersonalSubscription = keys.data?.some(
      (key) =>
        key.subscriptionKind === "chatgpt" &&
        key.scope === "personal" &&
        !key.isAgentKey,
    );
    if (!keyPermission.data || keyPermission.isError || keys.isError) {
      items.push({
        id: "chatgpt-subscription",
        label: "Verify your ChatGPT subscription",
        status: "now",
        action: (
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {keyPermission.isError || keys.isError
                ? "Subscription verification is unavailable. Try again."
                : "Subscription verification is unavailable without permission to read model provider keys."}
            </span>
            {keys.isError && keyPermission.data && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void keys.refetch()}
              >
                Retry
              </Button>
            )}
          </div>
        ),
      });
    } else if (!hasPersonalSubscription) {
      items.push({
        id: "chatgpt-subscription",
        label: "Connect your own ChatGPT subscription",
        status: "now",
        action: (
          <Button asChild size="sm" variant="outline">
            <Link
              href="/llm/model-providers?connect=chatgpt"
              target="_blank"
              rel="noopener noreferrer"
            >
              Sign in
            </Link>
          </Button>
        ),
      });
    } else if (selectedKey?.subscriptionKind !== "chatgpt") {
      items.push({
        id: "chatgpt-subscription",
        label: "Select a ChatGPT subscription for this agent",
        status: "now",
        action: (
          <Button asChild size="sm" variant="outline">
            <Link href={`/agents/${agentId}?section=general`}>Set up</Link>
          </Button>
        ),
      });
    }
  }
  return (
    <>
      <AgentSetupBanner
        key={agentId}
        items={items}
        showReady={showReady}
        resetKey={`${agentId}:${runtime.command?.join(" ")}:${runtime.claudeCode?.authentication}:${JSON.stringify(runtime.credentials ?? [])}`}
      />
      {credentialsOpen && (
        <AgentRuntimeCredentialsDialog
          agentId={agentId}
          declarations={runtime.credentials ?? []}
          canEditAgent={canEditAgent}
          onClose={() => setCredentialsOpen(false)}
        />
      )}
    </>
  );
}
