"use client";

import type { AgentType } from "@archestra/shared";
import Link from "next/link";
import { useMemo } from "react";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import {
  getShownProviders,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { McpClientInstructions } from "@/app/connection/mcp-client-instructions";
import { ProxyClientInstructions } from "@/app/connection/proxy-client-instructions";
import { useUpdateUrlParams } from "@/app/connection/use-update-url-params";
import { ConnectDialog } from "@/components/connect-dialog";
import config from "@/lib/config/config";
import { useOrganization } from "@/lib/organization.query";

/**
 * "Plug" row-action dialogs for the LLM Proxies and MCP Gateways tables: the
 * same generic connect instructions as the /connection page, scoped to the
 * clicked entity, without leaving the list.
 */

type ConnectTarget = {
  id: string;
  name: string;
  agentType: AgentType;
};

export function LlmProxyConnectInstructionsDialog({
  proxy,
  onOpenChange,
}: {
  /** Proxy to show instructions for; null keeps the dialog closed. */
  proxy: ConnectTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { baseUrl, organization } = useConnectionBaseUrl();
  const updateUrlParams = useUpdateUrlParams();

  if (!proxy) return null;

  return (
    <ConnectDialog
      agent={proxy}
      open
      onOpenChange={(open) => {
        // The instructions drive provider selection through the providerId URL
        // param — don't leave it behind on the list page.
        if (!open) updateUrlParams({ providerId: null });
        onOpenChange(open);
      }}
    >
      <div className="space-y-4">
        <ProxyClientInstructions
          client={genericConnectClient()}
          profileId={proxy.id}
          profileName={proxy.name}
          shownProviders={getShownProviders(organization)}
          baseUrl={baseUrl}
        />
        <ConnectionGuideFooter
          href={`/connection?proxyId=${encodeURIComponent(proxy.id)}&from=table`}
        />
      </div>
    </ConnectDialog>
  );
}

export function McpGatewayConnectInstructionsDialog({
  gateway,
  onOpenChange,
}: {
  /** Gateway to show instructions for; null keeps the dialog closed. */
  gateway: (ConnectTarget & { slug?: string | null }) | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { baseUrl } = useConnectionBaseUrl();

  if (!gateway) return null;

  return (
    <ConnectDialog agent={gateway} open onOpenChange={onOpenChange}>
      <div className="space-y-4">
        <McpClientInstructions
          client={genericConnectClient()}
          gatewayId={gateway.id}
          gatewaySlug={gateway.slug ?? gateway.id}
          gatewayName={gateway.name}
          baseUrl={baseUrl}
        />
        <ConnectionGuideFooter
          href={`/connection?gatewayId=${encodeURIComponent(gateway.id)}&from=table`}
        />
      </div>
    </ConnectDialog>
  );
}

// =========================================================================
// Internal helpers
// =========================================================================

function ConnectionGuideFooter({ href }: { href: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Setting up a specific client (Claude Code, Cursor, n8n, …)?{" "}
      <Link href={href} className="text-primary hover:underline">
        Open the connection guide
      </Link>
    </p>
  );
}

function genericConnectClient() {
  const client = CONNECT_CLIENTS.find((c) => c.id === "generic");
  if (!client) throw new Error("Missing generic connect client");
  return client;
}

/** Same base-URL resolution as the /connection page and post-create dialog. */
function useConnectionBaseUrl() {
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
  return { baseUrl, organization };
}
