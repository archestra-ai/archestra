"use client";

import { E2eTestId } from "@archestra/shared";
import { ArrowRight, Loader2, Network, Route } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { CodeText } from "@/components/code-text";
import { CopyableCode } from "@/components/copyable-code";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { useProfile } from "@/lib/agent.query";
import config from "@/lib/config/config";
import { useOrganization } from "@/lib/organization.query";

/**
 * Follow-up dialog shown right after creating an MCP Gateway or LLM Proxy,
 * so the creation flow ends with "here's how to use it" instead of a closed
 * dialog. Shows the object's endpoint and hands off to the /connection guide
 * (pre-selected) for client-specific setup.
 */
export function PostCreateConnectDialog({
  created,
  agentType,
  onOpenChange,
}: {
  /** The just-created object from AgentDialog's onCreated; null = closed. */
  created: { id: string; name: string } | null;
  agentType: "mcp_gateway" | "llm_proxy";
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const isGateway = agentType === "mcp_gateway";
  const [navigating, setNavigating] = useState(false);

  // The gateway endpoint uses the slug, which onCreated doesn't carry.
  const { data: agent, isPending } = useProfile(created?.id);

  // Same base-URL resolution as the /connection page; the compact dialog
  // shows the default URL and leaves environment switching to the guide.
  const { data: organization } = useOrganization();
  const connectionBaseUrls = organization?.connectionBaseUrls ?? null;
  const baseUrl = useMemo(() => {
    const candidates = resolveCandidateBaseUrls({
      externalProxyUrls: config.api.externalProxyUrls,
      internalProxyUrl: config.api.internalProxyUrl,
      metadata: connectionBaseUrls,
    });
    const adminDefault = resolveAdminDefaultBaseUrl(connectionBaseUrls);
    return adminDefault && candidates.includes(adminDefault)
      ? adminDefault
      : candidates[0];
  }, [connectionBaseUrls]);

  if (!created) return null;

  const endpointUrl = isGateway
    ? `${baseUrl}/mcp/${agent?.slug ?? created.id}`
    : `${baseUrl}/model-router/${created.id}`;
  const Icon = isGateway ? Route : Network;

  const openConnectionGuide = () => {
    setNavigating(true);
    const param = isGateway ? "gatewayId" : "proxyId";
    router.push(
      `/connection?${param}=${encodeURIComponent(created.id)}&from=create`,
    );
  };

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <span>"{created.name}" created — connect to it</span>
        </div>
      }
      size="small"
    >
      <DialogBody
        className="space-y-4"
        data-testid={E2eTestId.PostCreateConnectDialog}
      >
        <p className="text-sm text-muted-foreground">
          {isGateway
            ? "Your MCP gateway is ready. Point an MCP client at this endpoint — it authenticates with your platform tokens or an OAuth client."
            : "Your LLM proxy is ready. Route LLM requests through this base URL — clients authenticate with a provider key or a virtual key."}
        </p>
        {isGateway && isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Resolving endpoint…
          </div>
        ) : (
          <CopyableCode
            value={endpointUrl}
            toastMessage="Endpoint URL copied"
            variant="primary"
          >
            <CodeText className="text-xs text-primary break-all">
              {endpointUrl}
            </CodeText>
          </CopyableCode>
        )}
        <p className="text-sm text-muted-foreground">
          The connection guide has copy-paste setup for your client (Claude
          Code, Cursor, n8n, and more).
        </p>
      </DialogBody>
      <DialogStickyFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          data-testid={E2eTestId.PostCreateConnectDoneButton}
        >
          Done
        </Button>
        <Button
          type="button"
          onClick={openConnectionGuide}
          disabled={navigating}
          data-testid={E2eTestId.PostCreateOpenConnectionGuideButton}
        >
          {navigating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Open connection guide
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
