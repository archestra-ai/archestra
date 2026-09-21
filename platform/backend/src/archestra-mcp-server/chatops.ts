import { createHash } from "node:crypto";
import { TimeInMs, TOOL_POST_THREAD_FILE_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import { CHATOPS_ATTACHMENT_LIMITS } from "@/agents/chatops/constants";
import { threadFileStore } from "@/agents/chatops/thread-file-store";
import { CacheKey, cacheManager } from "@/cache-manager";
import { evaluateSingleMcpToolInvocationPolicy } from "@/guardrails/tool-invocation";
import { buildPolicyBlockedToolResult } from "@/guardrails/tool-policy-link";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsChannelBindingModel,
  ChatOpsProcessedMessageModel,
  EnvironmentModel,
  ToolModel,
} from "@/models";
import { evaluateRemoteServerUrlAgainstNetworkPolicy } from "@/services/environments/remote-server-network-policy";
import { ephemeralSandboxStore } from "@/skills-sandbox/ephemeral-sandbox-store";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { archestraMcpBranding } from "./branding";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
  structuredToolErrorResult,
} from "./helpers";

const ReceiptSchema = z.object({
  slack_file_id: z.string(),
  channel_id: z.string(),
  thread_ts: z.string(),
  sha256: z.string(),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_POST_THREAD_FILE_SHORT_NAME,
    title: "Post Thread File",
    description:
      "Post an original or generated file (including images and documents) as a native file in the current Slack thread. " +
      "Files must be nonempty and at most 20 MiB. " +
      "Use the fileId and sha256 from this turn's file references or download_file's threadFile result. " +
      "References expire when this execution ends. The backend transfers the bytes privately to Slack; " +
      "never supply a URL, base64, or a channel. For processing, first use upload_file with " +
      "source {type: 'thread_file', fileId}. Approval-required policies block this headless operation.",
    schema: z.strictObject({
      file_id: z.string().regex(/^chatops_file_[0-9a-f-]{36}$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      comment: z.string().max(3000).optional(),
    }),
    outputSchema: ReceiptSchema.extend({ already_sent: z.boolean() }),
    async handler({ args, context }) {
      const {
        organizationId,
        userId,
        isolationKey,
        chatOpsBindingId,
        chatOpsThreadId,
        chatOpsMessageId,
      } = context;
      if (
        !organizationId ||
        !userId ||
        userId === "system" ||
        !isolationKey ||
        !chatOpsBindingId ||
        !chatOpsThreadId ||
        !chatOpsMessageId ||
        context.appId
      ) {
        return errorResult(
          "Files can only be posted from the current Slack channel thread.",
        );
      }
      try {
        const binding =
          await ChatOpsChannelBindingModel.findById(chatOpsBindingId);
        if (
          !binding ||
          binding.organizationId !== organizationId ||
          binding.provider !== "slack" ||
          binding.isDm ||
          !/^\d+\.\d+$/.test(chatOpsThreadId)
        ) {
          return errorResult(
            "The current Slack channel thread is unavailable.",
          );
        }
        const file = threadFileStore.resolve({
          scope: {
            organizationId,
            userId,
            isolationKey,
            chatOpsBindingId,
            chatOpsThreadId,
          },
          fileId: args.file_id,
        });
        if (!file) {
          return errorResult(
            "This file reference is unavailable or belongs to another execution. Use a file from the current turn.",
          );
        }
        if (file.sha256 !== args.sha256) {
          return errorResult(
            "The file does not match the supplied content hash. Use its current fileId and sha256.",
          );
        }
        if (
          !file.sizeBytes ||
          file.sizeBytes > CHATOPS_ATTACHMENT_LIMITS.MAX_THREAD_FILE_SIZE
        ) {
          return errorResult(
            "The file must be nonempty and no larger than 20 MiB.",
          );
        }
        if (
          !file.filename ||
          file.filename.length > 255 ||
          /[/\\]/.test(file.filename) ||
          [...file.filename].some((character) => character.charCodeAt(0) < 32)
        ) {
          return errorResult(
            "Use a plain filename without path separators or control characters.",
          );
        }
        const agent = await AgentModel.findById(context.agent.id);
        if (!agent || agent.organizationId !== organizationId) {
          return errorResult("Agent not found.");
        }
        if (
          agent.environmentId &&
          !(await EnvironmentModel.findByIdForOrganization(
            agent.environmentId,
            organizationId,
          ))
        ) {
          return errorResult("The agent's environment is unavailable.");
        }
        for (const serverUrl of [
          "https://slack.com",
          "https://files.slack.com",
        ]) {
          const verdict = await evaluateRemoteServerUrlAgainstNetworkPolicy({
            serverType: "remote",
            serverUrl,
            environmentId: agent.environmentId,
            organizationId,
          });
          if (!verdict.allowed) {
            return errorResult(
              "The agent's environment does not allow Slack file uploads. It must permit slack.com and files.slack.com.",
            );
          }
        }
        const toolName = archestraMcpBranding.getToolName(
          TOOL_POST_THREAD_FILE_SHORT_NAME,
        );
        const toolIds = await ToolModel.findBuiltInToolIdsByNames([toolName]);
        const toolId = toolIds.length === 1 ? toolIds[0] : undefined;
        if (!toolId) return errorResult("The Slack file tool is unavailable.");
        // Resolve policy inputs from the captured bytes and trusted destination,
        // never from model-supplied channel names or a mutable artifact id.
        const policyBlock = await evaluateSingleMcpToolInvocationPolicy({
          agentId: agent.id,
          toolName,
          toolInput: {
            ...args,
            provider: "slack",
            channel_id: binding.channelId,
            thread_ts: chatOpsThreadId,
            mime_type: file.mimeType,
            filename: file.filename,
            size_bytes: file.sizeBytes,
            sha256: file.sha256,
          },
          organizationId,
          contextIsTrusted: context.contextIsTrusted ?? false,
          sensitiveContextOrigin: context.sensitiveContextOrigin,
          externalAgentId: context.delegationChain,
          enabledToolNames: new Set([toolName]),
          resolvedToolId: toolId,
          // General chat approvals do not authorize this captured file and
          // destination. Until that binding exists, approval-required is closed.
          enforceApprovalRequired: true,
        });
        if (policyBlock) {
          const blocked = await buildPolicyBlockedToolResult({
            policyBlock,
            userId,
            organizationId,
          });
          return structuredToolErrorResult({
            error: blocked.error,
            text: blocked.text,
          });
        }
        const assertDeliveryActive = () => {
          context.abortSignal?.throwIfAborted();
          if (executionSandboxRegistry.isEphemeralExecution(isolationKey)) {
            ephemeralSandboxStore.assertExecutionActive(isolationKey);
          }
        };
        assertDeliveryActive();
        const deliveryId = createHash("sha256")
          .update(
            JSON.stringify([
              organizationId,
              chatOpsBindingId,
              binding.channelId,
              chatOpsThreadId,
              chatOpsMessageId,
              file.sha256,
            ]),
          )
          .digest("hex");
        const receiptKey =
          `${CacheKey.SlackFileDeliveryReceipt}-${deliveryId}` as const;
        // Claim in the durable ChatOps ledger for its seven-day retention window.
        // While a claim exists, a missing cached receipt must not cause a resend.
        const claimed = await ChatOpsProcessedMessageModel.tryMarkAsProcessed(
          `thread-file:${deliveryId}`,
        );
        if (!claimed) {
          const receipt = ReceiptSchema.safeParse(
            await cacheManager.get(receiptKey),
          );
          if (receipt.success) {
            return structuredSuccessResult(
              { ...receipt.data, already_sent: true },
              "This file was already posted to the current Slack thread.",
            );
          }
          return errorResult(
            "An upload of this file was already attempted for this message, but its outcome is unknown. Check the Slack thread before requesting another upload; this call will not resend it.",
          );
        }
        const audit = {
          organizationId,
          userId,
          agentId: agent.id,
          bindingId: binding.id,
          channelId: binding.channelId,
          threadId: chatOpsThreadId,
          messageId: chatOpsMessageId,
          fileId: args.file_id,
          sha256: file.sha256,
          deliveryId,
        };
        logger.info(audit, "[ChatOps] Slack file upload claimed");
        let uploaded: undefined | { fileId: string };
        try {
          const { chatOpsManager } = await import(
            "@/agents/chatops/chatops-manager"
          );
          uploaded = await chatOpsManager.uploadFileToBindingThread({
            bindingId: binding.id,
            threadId: chatOpsThreadId,
            filename: file.filename,
            data: file.data,
            comment: args.comment,
            expectedSlackDestination: {
              organizationId,
              channelId: binding.channelId,
            },
            assertDeliveryActive,
          });
        } catch {
          logger.warn(audit, "[ChatOps] Slack file upload outcome uncertain");
          return errorResult(
            "Slack did not confirm the upload. Check the thread and the bot's files:write permission. The file will not be automatically resent for this message because the upload may have succeeded.",
          );
        }
        if (!uploaded?.fileId) {
          logger.warn(
            audit,
            "[ChatOps] Slack file upload returned no file receipt",
          );
          return errorResult(
            "Slack did not return a file receipt. Check the thread; this file will not be automatically resent for this message.",
          );
        }
        const receipt = {
          slack_file_id: uploaded.fileId,
          channel_id: binding.channelId,
          thread_ts: chatOpsThreadId,
          sha256: file.sha256,
        };
        logger.info(
          { ...audit, slackFileId: uploaded.fileId },
          "[ChatOps] Slack file uploaded",
        );
        await cacheManager
          .set(receiptKey, receipt, 7 * TimeInMs.Day)
          .catch(() => {
            logger.warn(
              { deliveryId },
              "[ChatOps] Slack file receipt could not be cached",
            );
          });
        return structuredSuccessResult(
          { ...receipt, already_sent: false },
          `Posted ${file.filename} to the current Slack thread.`,
        );
      } catch {
        return errorResult(
          "The Slack file could not be delivered. Its source, permissions, or delivery state could not be verified.",
        );
      }
    },
  }),
]);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
