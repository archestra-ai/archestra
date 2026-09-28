"use client";

import { useMemo } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import config from "@/lib/config/config";
import { useOrganization } from "@/lib/organization.query";

/** Same base-URL resolution as the /connection and /llm/proxy pages. */
export function useConnectionBaseUrl(): string {
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
