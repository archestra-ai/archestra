import { randomUUID } from "node:crypto";
import { getAgentCatalogImages, isVaultReference } from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import { claudeCodeAccountRuntime } from "@/k8s/agent-runtime/claude-code-account";
import logger from "@/logging";
import { EnvironmentModel, OrganizationModel } from "@/models";
import ClaudeCodeAccountModel from "@/models/claude-code-account";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import {
  AgentRuntimeCredentialsRequiredError,
  ApiError,
  type ResolvedAgentRuntime,
} from "@/types";
import {
  ClaudeCodeAccountSchema,
  type ClaudeCodeAccountStatus,
  ClaudeCodeModelsSchema,
} from "@/types/claude-code-account";
import { resolveAgentRuntimeBackendDriver } from "./backends";

/** Personal account credentials use the same secret backend as other runtime
 * credentials. The flow ID fences asynchronous completion across replicas. */
class ClaudeCodeAccountManager {
  async status(
    params: AccountOwner & { inspectFlow?: boolean },
  ): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    const account = await ClaudeCodeAccountModel.find(owner);
    const flow = await ClaudeCodeAccountModel.flow(owner);
    const base = { requiresVaultReference: isByosEnabled() };
    if (flow && !isExpired(flow.expiresAt)) {
      if (flow.vaultReference)
        return { ...base, state: "connecting", flowId: flow.flowId };
      if (params.inspectFlow === false)
        return { ...base, state: "starting", flowId: flow.flowId };
      const result = ClaudeCodeAccountSchema.safeParse(
        await claudeCodeAccountRuntime.status(flow),
      );
      if (!result.success)
        throw new ApiError(
          502,
          "Claude Code returned an invalid sign-in status",
        );
      return {
        ...base,
        ...result.data,
        state:
          result.data.state === "connected" ? "connecting" : result.data.state,
        flowId: flow.flowId,
      };
    }
    if (account)
      return {
        ...base,
        state: isExpired(account.expiresAt) ? "expired" : "connected",
        expiresAt: account.expiresAt,
      };
    return { ...base, state: flow ? "failed" : "disconnected" };
  }

  async start(
    params: AccountOwner & { vaultReference?: string },
  ): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (isByosEnabled() && !params.vaultReference)
      throw new ApiError(
        400,
        "This deployment uses read-only Vault. Store a Claude setup-token in Vault and connect its path#key reference.",
      );
    if (
      params.vaultReference &&
      (!isByosEnabled() || !isVaultReference(params.vaultReference))
    )
      throw new ApiError(
        400,
        "A valid Vault path#key reference is required on a read-only Vault deployment",
      );
    // SPDX-SnippetEnd
    const previous = await ClaudeCodeAccountModel.flow(owner);
    const flowId = randomUUID();
    const flow = {
      flowId,
      namespace: owner.namespace,
      image: getAgentCatalogImages(config.agentRuntime.defaultImage)[
        "claude-code"
      ],
      vaultReference: params.vaultReference,
    };
    await ClaudeCodeAccountModel.startFlow({ owner, flow });
    if (previous) await this.deleteFlow(previous);
    try {
      await claudeCodeAccountRuntime.create({
        ...owner,
        image: flow.image,
        flowId,
        vaultReference: Boolean(params.vaultReference),
      });
    } catch {
      throw new ApiError(
        503,
        "Could not prepare Claude Code sign-in. Please try again.",
      );
    }
    return {
      state: params.vaultReference ? "connecting" : "starting",
      flowId,
      requiresVaultReference: isByosEnabled(),
    };
  }

  async complete(
    params: AccountOwner & { flowId: string; code?: string },
  ): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    const flow = await ClaudeCodeAccountModel.flow(owner);
    if (!flow || flow.flowId !== params.flowId || isExpired(flow.expiresAt))
      throw new ApiError(
        409,
        "This sign-in has expired. Start Claude Code sign-in again.",
      );
    if (Boolean(flow.vaultReference) !== isByosEnabled())
      throw new ApiError(
        409,
        "Secret storage changed. Start Claude Code sign-in again.",
      );
    let secretId: string | null = null;
    let stored = false;
    try {
      let token: string | undefined;
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (flow.vaultReference) {
        secretId = (
          await secretManager().createSecret(
            { value: flow.vaultReference },
            "claude-code-account",
          )
        ).id;
        token = await this.readToken(secretId);
      }
      // SPDX-SnippetEnd
      const result = CompletionSchema.safeParse(
        await claudeCodeAccountRuntime.complete({
          namespace: flow.namespace,
          flowId: params.flowId,
          code: params.code,
          token,
        }),
      );
      if (!result.success)
        throw new ApiError(
          502,
          "Claude Code returned an invalid sign-in result",
        );
      if (result.data.state !== "connected")
        return { state: result.data.state, flowId: params.flowId };
      if (!token && !result.data.token)
        throw new ApiError(
          502,
          "Claude Code did not return a subscription token",
        );
      secretId ??= (
        await secretManager().createSecret(
          { value: result.data.token },
          "claude-code-account",
        )
      ).id;
      const expiresAt = flow.vaultReference
        ? null
        : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const saved = await ClaudeCodeAccountModel.complete({
        owner,
        flowId: params.flowId,
        secretId,
        metadata: {
          image: flow.image,
          expiresAt,
          models: result.data.models,
        },
      });
      if (!saved)
        throw new ApiError(
          409,
          "This sign-in was replaced or disconnected. Start again.",
        );
      stored = true;
      await this.deleteSecret(saved.previousSecretId);
      await this.deleteFlow(flow);
      return {
        state: "connected",
        expiresAt,
        requiresVaultReference: isByosEnabled(),
      };
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
          ? account.models
          : [],
    };
  }

  async disconnect(params: AccountOwner): Promise<ClaudeCodeAccountStatus> {
    const owner = await this.placement(params);
    // Delete the connection first: neither a cached secret nor a late flow may
    // authorize a new run. Existing runs keep their already-issued credential.
    const { account, flow } = await ClaudeCodeAccountModel.delete(owner);
    await this.deleteSecret(account?.secretId ?? null);
    if (flow) await this.deleteFlow(flow);
    return { state: "disconnected", requiresVaultReference: isByosEnabled() };
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
    const effectiveNetworkPolicy = await resolveEffectiveNetworkPolicy({
      organizationId: params.runtime.organizationId,
      environmentId: params.runtime.environmentId,
      environmentNetworkPolicy: environment?.networkPolicy,
      defaultNetworkPolicy: organization?.defaultNetworkPolicy,
    });
    return {
      organizationId: params.runtime.organizationId,
      userId: params.userId,
      agentId: params.runtime.agentId,
      namespace,
      effectiveNetworkPolicy,
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

  private async deleteFlow(params: { namespace: string; flowId: string }) {
    try {
      await claudeCodeAccountRuntime.delete(params);
    } catch {
      logger.warn("Claude Code sign-in cleanup deferred to the Job deadline");
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
const CompletionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("connected"),
    token: TokenSchema.optional(),
    models: ClaudeCodeModelsSchema.shape.models,
  }),
  z.object({ state: z.enum(["connecting", "failed"]) }),
]);
function isExpired(date: Date | string | null) {
  return date !== null && new Date(date).getTime() <= Date.now();
}
