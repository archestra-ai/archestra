import type { FastifyRequest } from "fastify";
import config from "@/config";
import logger from "@/logging";
import {
  carriesConnectionSetupReference,
  connectionProxySetupContext,
  readVerifiedConnectionProxySetup,
} from "@/services/connection-proxy-setup-context";
import { claimConnectionSetupConversation } from "@/services/connection-setup-conversation-claim";

/**
 * Whether this request is the installer's own conversation under an approved
 * connection setup, which OpenAPPA lets through ungoverned. The conversation
 * claim is recorded whether or not OpenAPPA is active.
 */
export async function resolveInstallerSetupBypass(params: {
  request: FastifyRequest;
  body: unknown;
  agent: { id: string; organizationId: string };
  virtualKeyIds: readonly (string | undefined)[];
  appaActive: boolean;
}): Promise<boolean> {
  const { request, body, agent, appaActive } = params;
  const approvedProxySetupContext = connectionProxySetupContext(request.raw);
  let verifiedProxySetup: ReturnType<typeof readVerifiedConnectionProxySetup>;
  if (approvedProxySetupContext) {
    for (const keyId of params.virtualKeyIds) {
      if (!keyId) continue;
      verifiedProxySetup = readVerifiedConnectionProxySetup({
        token: approvedProxySetupContext,
        organizationId: agent.organizationId,
        virtualApiKeyId: keyId,
        proxyAgentId: agent.id,
        secret: config.auth.secret,
      });
      if (verifiedProxySetup) break;
    }
  }
  const approvedProxySetup = verifiedProxySetup !== undefined;
  // The setup URL stays in the client's settings for the whole window, so
  // sessions started after the setup send it too. The reference must be in
  // this request, and the first well-formed native conversation to present
  // it owns the exemption until the token expires.
  const carriesReference =
    approvedProxySetup &&
    !!approvedProxySetupContext &&
    carriesConnectionSetupReference({
      token: approvedProxySetupContext,
      requestBody: body,
      secret: config.auth.secret,
    });
  const installerConversation =
    carriesReference &&
    verifiedProxySetup !== undefined &&
    (await claimConnectionSetupConversation({
      organizationId: verifiedProxySetup.organizationId,
      setupId: verifiedProxySetup.setupId,
      expiresAt: verifiedProxySetup.expiresAt,
      headers: request.headers,
      requestBody: body,
    }));
  const installerSetupBypass = appaActive && installerConversation;
  if (installerSetupBypass) {
    logger.info(
      { profileId: agent.id, proof: "approved-installer" },
      "Connection setup APPA bypass active",
    );
  } else if (appaActive && approvedProxySetup) {
    logger.info(
      { profileId: agent.id },
      "Connection setup URL outside the installer's conversation; Guardrails apply",
    );
  }
  return installerSetupBypass;
}
