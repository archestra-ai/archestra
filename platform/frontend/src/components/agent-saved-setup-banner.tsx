"use client";

import Link from "next/link";
import { useState } from "react";
import { agentEditHref } from "@/components/agent-pages/agent-page-config";
import { adminOnlyDescription } from "@/components/agent-run-credential-prompt";
import { AgentRuntimeCredentialsDialog } from "@/components/agent-runtime-credentials-dialog";
import {
  AgentSetupBanner,
  type AgentSetupItem,
} from "@/components/agent-setup-banner";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/lib/agent.query";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";

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
  // The credential whose Set up was clicked: its dialog asks for it alone.
  const [credentialKey, setCredentialKey] = useState<string | null>(null);
  if (!runtime) {
    return <AgentSetupBanner key={agentId} items={[]} showReady={showReady} />;
  }
  const failed = preflight.isError;
  const loading = preflight.isPending;
  if (failed) {
    return (
      <QueryLoadError
        title="Cannot check agent setup"
        error={preflight.error}
        onRetry={() => void preflight.refetch()}
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
  // An organization credential this person may not run with blocks the agent
  // whatever else they set up, so it is the only thing worth showing. The
  // setup check reports these under `missing` only.
  const adminOnlyLabels = preflight.data.missing
    .filter((credential) => credential.adminOnly)
    .map(({ label }) => label);
  if (adminOnlyLabels.length > 0) {
    return (
      <AgentSetupBanner
        key={agentId}
        items={[
          {
            id: "admin-only",
            label: "Only admins can run this agent",
            description: adminOnlyDescription(adminOnlyLabels),
            status: "now",
          },
        ]}
        showReady={showReady}
      />
    );
  }
  const items: AgentSetupItem[] = Array.from(
    new Map(missing.map((credential) => [credential.key, credential])).values(),
  )
    // The person's own Claude sign-in is not listed here: the Account strip
    // under "Give it work" offers it, next to what their runs use.
    .filter(({ key }) => key !== "CLAUDE_CODE_ACCOUNT")
    .map(
      ({ key, label, canConnect }): AgentSetupItem =>
        canConnect === false
          ? {
              id: key,
              label: `Ask an admin for ${label}`,
              description: `This agent needs ${label} to run. Ask an admin to share it with you.`,
              status: "now",
            }
          : {
              id: key,
              label,
              description: `This agent needs ${label} in its container. Set a value, or connect it.`,
              status: "now",
              action: (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCredentialKey(key)}
                >
                  Set up
                </Button>
              ),
            },
    );
  if (preflight.data.incompatible) {
    items.push({
      id: "model-incompatible",
      label: preflight.data.incompatible,
      status: "now",
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href={agentEditHref(agentId)}>Review model</Link>
        </Button>
      ),
    });
  }
  return (
    <>
      {(items.length > 0 || showReady) && (
        <AgentSetupBanner
          key={agentId}
          items={items}
          showReady={showReady}
          resetKey={`${agentId}:${runtime.command?.join(" ")}:${runtime.claudeCode?.authentication}:${JSON.stringify(runtime.credentials ?? [])}`}
        />
      )}
      {credentialKey && (
        <AgentRuntimeCredentialsDialog
          agentId={agentId}
          declarations={runtime.credentials ?? []}
          canEditAgent={canEditAgent}
          onlyKeys={[credentialKey]}
          onClose={() => setCredentialKey(null)}
        />
      )}
    </>
  );
}
