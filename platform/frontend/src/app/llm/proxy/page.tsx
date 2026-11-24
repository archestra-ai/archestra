"use client";

import { useMemo } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import config from "@/lib/config/config";
import { useOrganization } from "@/lib/organization.query";
import { EndpointCard } from "./_parts/endpoint-card";
import { KeysCard } from "./_parts/keys-card";
import { PoolsCard } from "./_parts/pools-card";
import { ProvidersCard } from "./_parts/providers-card";
import { SummaryTiles } from "./_parts/summary-tiles";

/**
 * The LLM Proxy as a dashboard: what is set up (providers, pools and routers,
 * virtual keys), guardrails and budgets, and a ready-to-run request. Each item
 * opens its own page; each "+" opens its create dialog here.
 */
export default function LlmProxyPage() {
  const baseUrl = useConnectionBaseUrl();
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <ProvidersCard />
        <PoolsCard />
        <KeysCard />
      </div>
      <SummaryTiles />
      <EndpointCard baseUrl={baseUrl} />
    </div>
  );
}

/** Same base-URL resolution as the /connection page. */
function useConnectionBaseUrl() {
  const { data: organization } = useOrganization();
  const connectionBaseUrls = organization?.connectionBaseUrls ?? null;
  return useMemo(() => {
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
}
