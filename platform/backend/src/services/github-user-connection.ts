import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import config from "@/config";
import { parseGitHubAppSecrets } from "@/integrations/github/app-secrets";
import {
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
  VerificationModel,
} from "@/models";
import McpDeploymentLeaseModel, {
  ClusterLeaseHeldError,
} from "@/models/mcp-deployment-lease";
import { isByosEnabled } from "@/secrets-manager";
import { ApiError } from "@/types";

class GitHubUserConnectionManager {
  async start(owner: Owner) {
    if (isByosEnabled())
      throw new ApiError(
        400,
        "GitHub sign-in requires writable secret storage",
      );
    const app = await this.app(owner);
    return this.lock(owner, async () => {
      const state = `${owner.credentialId}:${randomBytes(32).toString("base64url")}`;
      const verifier = randomBytes(32).toString("base64url");
      const identifier = flowIdentifier(owner);
      await VerificationModel.deleteByIdentifier(identifier);
      await VerificationModel.create({
        identifier,
        expiresAt: new Date(Date.now() + 600_000),
        value: JSON.stringify({
          stateHash: hash(state),
          verifier,
          clientId: app.clientId,
        }),
      });
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: callbackUrl(),
        state,
        code_challenge: hash(verifier),
        code_challenge_method: "S256",
        allow_signup: "false",
      }).toString();
      return { authorizationUrl: url.toString() };
    });
  }

  async complete(params: {
    organizationId: string;
    userId: string;
    state: string;
    code: string;
  }) {
    const credentialId = params.state.split(":")[0];
    const owner = {
      organizationId: params.organizationId,
      userId: params.userId,
      credentialId,
    };
    return this.lock(owner, async (assertOwned) => {
      const record = await VerificationModel.getByIdentifier(
        flowIdentifier(owner),
      );
      const flow = record
        ? FlowSchema.safeParse(JSON.parse(record.value))
        : null;
      if (
        !record ||
        record.expiresAt <= new Date() ||
        !flow?.success ||
        flow.data.stateHash !== hash(params.state)
      )
        throw new ApiError(
          400,
          "GitHub sign-in expired or belongs to another account. Start again.",
        );
      const app = await this.app(owner);
      if (flow.data.clientId !== app.clientId)
        throw new ApiError(409, "GitHub App changed. Start sign-in again.");
      await assertOwned();
      if (!(await VerificationModel.consume(flowIdentifier(owner))))
        throw new ApiError(400, "GitHub sign-in expired. Start again.");
      const token = await this.exchange({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code: params.code,
        redirect_uri: callbackUrl(),
        code_verifier: flow.data.verifier,
      });
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      const identity = response.ok
        ? IdentitySchema.safeParse(await response.json())
        : null;
      if (!identity?.success)
        throw new ApiError(
          502,
          "Could not verify the authorized GitHub account",
        );
      const before = await RuntimeCredentialConnectionModel.findForAudit({
        ...owner,
        scope: "personal",
      });
      await assertOwned();
      await RuntimeCredentialConnectionModel.upsert({
        ...owner,
        scope: "personal",
        value: JSON.stringify({
          ...token,
          clientId: app.clientId,
          githubId: identity.data.id,
          login: identity.data.login,
        }),
      });
      const after = await RuntimeCredentialConnectionModel.findForAudit({
        ...owner,
        scope: "personal",
      });
      return { credentialId, login: identity.data.login, before, after };
    });
  }

  async resolve(owner: Owner & { minimumValidityMs?: number }) {
    return this.lock(owner, async (assertOwned) => {
      const raw = await RuntimeCredentialConnectionModel.resolveValue({
        ...owner,
        scope: "personal",
      });
      if (!raw) return null;
      const token = StoredTokenSchema.parse(JSON.parse(raw));
      const app = await this.app(owner);
      if (token.clientId !== app.clientId)
        throw new ApiError(
          400,
          "The GitHub App changed. Connect GitHub again.",
        );
      if (token.expiresAt - Date.now() > (owner.minimumValidityMs ?? 60_000))
        return { value: token.accessToken, expiresAt: token.expiresAt };
      if (token.refreshExpiresAt <= Date.now()) return null;
      const next = await this.exchange({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      });
      await assertOwned();
      await RuntimeCredentialConnectionModel.upsert({
        ...owner,
        scope: "personal",
        value: JSON.stringify({ ...token, ...next }),
      });
      return { value: next.accessToken, expiresAt: next.expiresAt };
    });
  }

  async disconnect(owner: Owner) {
    return this.lock(owner, async () => {
      await VerificationModel.deleteByIdentifier(flowIdentifier(owner));
      return RuntimeCredentialConnectionModel.delete({
        ...owner,
        scope: "personal",
      });
    });
  }

  private async app(owner: Owner) {
    const definition = await RuntimeCredentialDefinitionModel.find({
      organizationId: owner.organizationId,
      key: owner.credentialId,
    });
    if (
      definition?.kind !== "github_app_user" ||
      !definition.allowPersonal ||
      !definition.githubAppCredentialKey
    )
      throw new ApiError(
        400,
        "This credential does not support GitHub sign-in",
      );
    const app = await RuntimeCredentialDefinitionModel.find({
      organizationId: owner.organizationId,
      key: definition.githubAppCredentialKey,
    });
    // OAuth endpoints are fixed to GitHub.com; an arbitrary API URL must never receive a user token.
    if (
      app?.kind !== "github_app" ||
      !app.allowOrganization ||
      app.githubUrl !== "https://api.github.com" ||
      !app.githubClientId
    )
      throw new ApiError(
        400,
        "Configure an organization GitHub.com App with an OAuth client ID first",
      );
    const secret = await RuntimeCredentialConnectionModel.resolveValue({
      organizationId: owner.organizationId,
      credentialId: app.key,
      scope: "organization",
    });
    const clientSecret = secret
      ? parseGitHubAppSecrets(secret).clientSecret
      : undefined;
    if (!clientSecret)
      throw new ApiError(
        400,
        "An administrator must connect the GitHub App OAuth client secret",
      );
    return { clientId: app.githubClientId, clientSecret };
  }

  private async exchange(body: Record<string, string>) {
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      },
    );
    const payload = response.ok
      ? TokenResponseSchema.safeParse(await response.json())
      : null;
    if (!payload?.success)
      throw new ApiError(
        400,
        "GitHub authorization failed. Connect GitHub again and ensure expiring user tokens are enabled.",
      );
    return {
      accessToken: payload.data.access_token,
      refreshToken: payload.data.refresh_token,
      expiresAt: Date.now() + payload.data.expires_in * 1000,
      refreshExpiresAt:
        Date.now() + payload.data.refresh_token_expires_in * 1000,
    };
  }

  private async lock<T>(
    owner: Owner,
    fn: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await McpDeploymentLeaseModel.withLease(
          { scope: "github-user-connection", key: flowIdentifier(owner) },
          (guard) => fn(guard.assertOwned),
        );
      } catch (error) {
        if (!(error instanceof ClusterLeaseHeldError)) throw error;
        await delay(250);
      }
    }
    throw new ApiError(409, "GitHub connection is busy. Try again shortly.");
  }
}

export const githubUserConnectionManager = new GitHubUserConnectionManager();

// ===================== Internals =====================

type Owner = { organizationId: string; userId: string; credentialId: string };
const IdentitySchema = z.object({
  id: z.number().int().positive(),
  login: z.string().regex(/^[a-zA-Z0-9-]+$/),
});
const FlowSchema = z.object({
  stateHash: z.string(),
  verifier: z.string(),
  clientId: z.string(),
});
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token_expires_in: z.number().positive(),
});
const StoredTokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  refreshExpiresAt: z.number(),
  clientId: z.string(),
  githubId: z.number(),
  login: z.string(),
});
function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
function flowIdentifier(owner: Owner) {
  return `github-user:${hash(JSON.stringify([owner.organizationId, owner.userId, owner.credentialId]))}`;
}
function callbackUrl() {
  return `${config.frontendBaseUrl}/settings/credentials/github/callback`;
}
