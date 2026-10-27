import { randomUUID } from "node:crypto";
import { z } from "zod";
import logger from "@/logging";
import { EnvironmentModel, OrganizationModel } from "@/models";
import ClaudeCodeAccountModel from "@/models/claude-code-account";
import { secretManager } from "@/secrets-manager";
import {
  AgentRuntimeCredentialsRequiredError,
  ApiError,
  type ResolvedAgentRuntime,
} from "@/types";
import type { ClaudeCodeAccountStatus } from "@/types/claude-code-account";
import { decryptSecretValue, encryptSecretValue } from "@/utils/crypto";
import { resolveAgentRuntimeBackendDriver } from "./backends";
import { claudeCodeOAuth } from "./claude-code-oauth";

/** Personal account credentials use the same secret backend as other runtime
 * credentials. The flow ID fences asynchronous completion across replicas. */
class ClaudeCodeAccountManager {
  async status(
    params: AccountOwner & { inspectFlow?: boolean },
  ): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    const account = await ClaudeCodeAccountModel.find(owner);
    const flow = await ClaudeCodeAccountModel.flow(owner);
    if (flow && !isExpired(flow.expiresAt)) {
      if (flow.failed || !flow.oauth)
        return { state: "failed", flowId: flow.flowId };
      if (flow.completionStarted)
        return { state: "connecting", flowId: flow.flowId };
      return {
        state: "awaiting_code",
        flowId: flow.flowId,
        ...(params.inspectFlow === false
          ? {}
          : {
              authorizationUrl: claudeCodeOAuth.authorizationUrl(
                readOAuth(flow.oauth),
              ),
            }),
      };
    }
    if (account)
      return {
        state: isExpired(account.expiresAt) ? "expired" : "connected",
        expiresAt: account.expiresAt,
      };
    return { state: flow ? "failed" : "disconnected" };
  }

  async start(params: AccountOwner): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    const oauth = claudeCodeOAuth.create();
    const flowId = randomUUID();
    await ClaudeCodeAccountModel.startFlow({
      owner,
      flow: {
        flowId,
        oauth: {
          state: oauth.state,
          verifier: encryptSecretValue({ verifier: oauth.verifier }),
        },
      },
    });
    return {
      state: "awaiting_code",
      flowId,
      authorizationUrl: claudeCodeOAuth.authorizationUrl(oauth),
    };
  }

  async complete(
    params: AccountOwner & { flowId: string; code?: string },
  ): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    const flow = await ClaudeCodeAccountModel.flow(owner);
    if (
      !flow ||
      flow.flowId !== params.flowId ||
      isExpired(flow.expiresAt) ||
      flow.failed ||
      !flow.oauth
    )
      throw new ApiError(
        409,
        "This sign-in has expired. Start Claude Code sign-in again.",
      );
    if (flow.completionStarted)
      return { state: "connecting", flowId: params.flowId };
    const oauth = readOAuth(flow.oauth);
    const code = claudeCodeOAuth.parseCode({
      code: params.code ?? "",
      state: oauth.state,
    });
    if (
      !(await ClaudeCodeAccountModel.claimFlow({
        owner,
        flowId: params.flowId,
      }))
    )
      throw new ApiError(
        409,
        "This sign-in was already submitted or replaced. Check its status or start again.",
      );
    let secretId: string | null = null;
    let stored = false;
    try {
      const { token, expiresAt } = await claudeCodeOAuth.exchange({
        ...oauth,
        code,
      });
      if (!token)
        throw new ApiError(502, "Claude did not return a subscription token");
      secretId ??= (
        await secretManager().createSecret(
          { value: token },
          "claude-code-account",
        )
      ).id;
      const saved = await ClaudeCodeAccountModel.complete({
        owner,
        flowId: params.flowId,
        secretId,
        metadata: {
          expiresAt,
          models: [],
        },
      });
      if (!saved)
        throw new ApiError(
          409,
          "This sign-in was replaced or disconnected. Start again.",
        );
      stored = true;
      await this.deleteSecret(saved.previousSecretId);
      return {
        state: "connected",
        expiresAt,
      };
    } catch (error) {
      await ClaudeCodeAccountModel.failFlow({ owner, flowId: params.flowId });
      throw error;
    } finally {
      if (!stored) await this.deleteSecret(secretId);
    }
  }

  async models(params: AccountOwner) {
    const owner = await this.placement(params);
    const account = await ClaudeCodeAccountModel.find(owner);
    return {
      models:
        account?.secretId && !isExpired(account.expiresAt)
          ? await claudeCodeOAuth.models(await this.readToken(account.secretId))
          : [],
    };
  }

  async disconnect(params: AccountOwner): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    // Delete the connection first: neither a cached secret nor a late flow may
    // authorize a new run. Existing runs keep their already-issued credential.
    const { account } = await ClaudeCodeAccountModel.delete(owner);
    await this.deleteSecret(account?.secretId ?? null);
    return { state: "disconnected" };
  }

  async requireConnection(
    params: AccountOwner & { runtimeScope: string },
  ): Promise<string> {
    const owner = await this.placement(params);
    if (owner.namespace !== params.runtimeScope)
      throw new ApiError(
        409,
        "The Agent environment changed. Start the run again.",
      );
    const account = await ClaudeCodeAccountModel.find(owner);
    if (!account?.secretId || isExpired(account.expiresAt))
      throw new AgentRuntimeCredentialsRequiredError(params.runtime.agentId, [
        {
          key: "CLAUDE_CODE_ACCOUNT",
          label: "Claude Code account",
          description:
            "Sign in with your own Claude account in the native runtime.",
        },
      ]);
    return this.readToken(account.secretId);
  }

  private async placement(params: AccountOwner) {
    if (params.runtime.command?.[0] !== "archestra-claude-code")
      throw new ApiError(
        400,
        "Claude subscriptions are only available in the Claude Code runtime.",
      );
    const [organization, environment] = await Promise.all([
      OrganizationModel.getById(params.runtime.organizationId),
      params.runtime.environmentId
        ? EnvironmentModel.findByIdForOrganization(
            params.runtime.environmentId,
            params.runtime.organizationId,
          )
        : null,
    ]);
    const namespace = resolveAgentRuntimeBackendDriver(
      params.runtime.backend,
    ).resolveRuntimeScope({
      environmentScope: environment?.namespace,
      organizationScope: organization?.defaultEnvironmentNamespace,
    });
    return {
      organizationId: params.runtime.organizationId,
      userId: params.userId,
      agentId: params.runtime.agentId,
      namespace,
    };
  }

  private async readToken(secretId: string) {
    const secret = await secretManager().getSecret(secretId, {
      skipCache: true,
    });
    const result = TokenSchema.safeParse(secret?.secret.value);
    if (!result.success)
      throw new ApiError(
        409,
        "The Claude Code credential is unavailable. Reconnect your account.",
      );
    return result.data;
  }

  private async deleteSecret(secretId: string | null) {
    if (!secretId) return;
    try {
      await secretManager().deleteSecret(secretId);
    } catch {
      logger.warn("Could not remove a disconnected Claude Code secret");
    }
  }
}

export const claudeCodeAccountManager = new ClaudeCodeAccountManager();

type AccountOwner = { runtime: ResolvedAgentRuntime; userId: string };
const TokenSchema = z
  .string()
  .min(32)
  .max(8192)
  .regex(/^sk-ant-oat[0-9]+-[A-Za-z0-9_-]+$/);
function readOAuth(
  oauth: { state: string; verifier: { __encrypted: string } } | undefined,
) {
  if (!oauth) throw new ApiError(409, "Start Claude Code sign-in again.");
  const { verifier } = decryptSecretValue(oauth.verifier);
  if (typeof verifier !== "string")
    throw new ApiError(409, "Start Claude Code sign-in again.");
  return { state: oauth.state, verifier };
}
function isExpired(date: Date | string | null) {
  return date !== null && new Date(date).getTime() <= Date.now();
}
