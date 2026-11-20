// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { fromWebToken } from "@aws-sdk/credential-providers";
import { AwsClient } from "aws4fetch";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import {
  platformSpiffeId,
  spiffeIdForAgent,
  spiffeIssuer,
} from "@/services/identity-providers/enterprise-managed/spiffe-issuer";
import type { AwsIamMcpAuthConfig } from "@/types/aws-iam-mcp-auth";

// Read by the singleton below at import time, so declared before it.
/** The audience AWS's own examples register on an IAM OIDC provider. */
const DEFAULT_AUDIENCE = "sts.amazonaws.com";
const CREDENTIALS_LIFETIME_SECONDS = 60 * 60;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_CACHED_SESSIONS = 1000;

/**
 * Signs requests to MCP servers behind an AWS service that verifies SigV4,
 * as the agent making the call. The agent assumes the server's IAM role with
 * its own JWT-SVID (AssumeRoleWithWebIdentity), so the role's trust policy
 * decides which agents may call the server, and CloudTrail names the agent as
 * the role session. Without an agent, as when its tools are listed, the
 * platform's own SPIFFE ID assumes the role.
 */
class AwsIamMcpSigner {
  private credentials = new LRUCacheManager<AwsTemporaryCredentials>({
    maxSize: MAX_CACHED_SESSIONS,
    defaultTtl: CREDENTIALS_LIFETIME_SECONDS * 1000,
  });

  /**
   * Assumes the caller's role session now, so a refusal surfaces as a clear
   * error before any request is sent. Later requests reuse the session.
   */
  async assumeRole(params: {
    config: AwsIamMcpAuthConfig;
    agentId: string | null;
  }): Promise<void> {
    await this.getCredentials(params);
  }

  /**
   * A fetch that signs each request with the caller's role session, read per
   * request so a long-lived connection never signs with an expired one.
   */
  signingFetch(params: {
    config: AwsIamMcpAuthConfig;
    agentId: string | null;
    dispatch?: typeof fetch;
  }): typeof fetch {
    return async (input, init) => {
      const credentials = await this.getCredentials(params);
      const client = new AwsClient({
        ...credentials,
        region: params.config.region,
        service: params.config.service,
        // The MCP client handles its own retries; a signed retry here would
        // hide upstream failures behind delays.
        retries: 0,
      });
      const signed = await client.sign(input, init);
      if (params.dispatch && typeof init?.body === "string") {
        return params.dispatch(signed.url, {
          ...init,
          headers: signed.headers,
          signal: signed.signal,
        });
      }
      return fetch(signed);
    };
  }

  /** Drops cached role sessions, so the next call assumes the role again. */
  clearCache(): void {
    this.credentials.clear();
  }

  private async getCredentials(params: {
    config: AwsIamMcpAuthConfig;
    agentId: string | null;
  }): Promise<AwsTemporaryCredentials> {
    const { config, agentId } = params;
    const audience = config.audience || DEFAULT_AUDIENCE;
    const cacheKey = [agentId ?? "", config.roleArn, config.region, audience]
      .map(encodeURIComponent)
      .join(":");
    const cached = this.credentials.get(cacheKey);
    if (cached) return cached;

    const webIdentityToken = await spiffeIssuer.mintJwtSvid({
      spiffeId: agentId ? spiffeIdForAgent(agentId) : platformSpiffeId(),
      audience,
    });
    let issued: Awaited<ReturnType<ReturnType<typeof fromWebToken>>>;
    try {
      issued = await fromWebToken({
        roleArn: config.roleArn,
        webIdentityToken,
        roleSessionName: agentId ? `agent-${agentId}` : "platform",
        durationSeconds: CREDENTIALS_LIFETIME_SECONDS,
        clientConfig: { region: config.region },
      })();
    } catch (error) {
      logger.warn(
        {
          roleArn: config.roleArn,
          agentId,
          error: error instanceof Error ? error.name : "unknown",
        },
        "[aws-iam] AWS refused to let the caller assume the MCP server's role",
      );
      throw new Error(
        `AWS refused to let ${agentId ? "this agent" : "the platform"} assume ${config.roleArn}: ${error instanceof Error ? error.message : "unknown error"}. Check the role's trust policy and the IAM OIDC provider for this deployment's SPIFFE issuer.`,
      );
    }

    const credentials = {
      accessKeyId: issued.accessKeyId,
      secretAccessKey: issued.secretAccessKey,
      sessionToken: issued.sessionToken,
    };
    // Kept until shortly before AWS expires the session.
    const expiresInMs = issued.expiration
      ? issued.expiration.getTime() - Date.now() - EXPIRY_MARGIN_MS
      : 0;
    if (expiresInMs > 0)
      this.credentials.set(cacheKey, credentials, expiresInMs);
    return credentials;
  }
}

export const awsIamMcpSigner = new AwsIamMcpSigner();

// === Internal helpers

type AwsTemporaryCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
};
