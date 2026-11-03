import { runBackfill } from "@/auto-routing/backfill";
import { openappaBatteriesService } from "@/openappa/batteries";
import { threadStates } from "@/openappa/thread-state";
import { deleteExpiredUnenforcedRecords } from "@/openappa/unenforced";
import { handleJiraChatOpsEvent } from "@/services/jira-chatops-events";
import { pollJiraChatOps } from "@/services/jira-chatops-poll";
import {
  checkDueAppaGithubSyncs,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { runAutomaticOpenAppaPolicyTests } from "@/services/openappa-policy-tests";
import type { TaskQueueService } from "../task-queue";
import { handleAgentRunAttentionNotice } from "./agent-run-attention-notice-handler";
import { handleAuditLogCleanup } from "./audit-log-cleanup-handler";
import { autoRoutingDispatcher } from "./auto-routing-dispatch-handler";
import { handleAutoRoutingFit } from "./auto-routing-fit-handler";
import { handleBatchEmbedding } from "./batch-embedding-handler";
import { handleCheckDueConnectors } from "./check-due-connectors-handler";
import { handleCheckDuePermissionSyncs } from "./check-due-permission-syncs-handler";
import { handleCheckDuePluginGithubSyncs } from "./check-due-plugin-github-syncs-handler";
import { handleCheckDueScheduleTriggers } from "./check-due-schedule-triggers-handler";
import { handleCheckDueSkillGithubSyncs } from "./check-due-skill-github-syncs-handler";
import { handleConnectorSync } from "./connector-sync-handler";
// biome-ignore lint/style/noRestrictedImports: dual-licensed, no-op unless the feature is enabled
import { handleContentEncryptionBackfill } from "./content-encryption-backfill-handler.ee";
// biome-ignore lint/style/noRestrictedImports: dual-licensed, gated at boot by the retention license gate
import { handleContentRetentionCleanup } from "./content-retention-cleanup-handler.ee";
import { handleHeadlessSandboxCleanup } from "./headless-sandbox-cleanup-handler";
import { handleInteractionSessionPreviewBackfill } from "./interaction-session-preview-backfill-handler";
import { handleInteractionUserActivityRebuild } from "./interaction-user-activity-rebuild-handler";
import { handleKbBm25StatsRefresh } from "./kb-bm25-stats-refresh-handler";
import { handleLlmModelSync } from "./llm-model-sync-handler";
import { handleMcpToolDescriptionBackfill } from "./mcp-tool-description-backfill-handler";
import { handleModelCostBackfill } from "./model-cost-backfill-handler";
import { handleP4ShimReconcile } from "./p4-shim-reconcile-handler";
import { handlePermissionSync } from "./permission-sync-handler";
import { handlePluginGithubSync } from "./plugin-github-sync-handler";
import { handleScheduleTriggerRunExecution } from "./schedule-trigger-run-handler";
import { handleSkillGithubSync } from "./skill-github-sync-handler";
import { handleSkillPublicationBackfill } from "./skill-publication-backfill-handler";

export function registerTaskHandlers(taskQueueService: TaskQueueService): void {
  taskQueueService.registerHandler("jira_chatops_poll", pollJiraChatOps);
  taskQueueService.registerHandler(
    "jira_chatops_event",
    handleJiraChatOpsEvent,
  );
  taskQueueService.registerHandler(
    "agent_run_attention_notice",
    handleAgentRunAttentionNotice,
  );
  taskQueueService.registerHandler(
    "interaction_user_activity_rebuild",
    handleInteractionUserActivityRebuild,
  );
  taskQueueService.registerHandler("connector_sync", handleConnectorSync);
  taskQueueService.registerHandler("batch_embedding", handleBatchEmbedding);
  taskQueueService.registerHandler("permission_sync", handlePermissionSync);
  taskQueueService.registerHandler(
    "check_due_connectors",
    handleCheckDueConnectors,
  );
  taskQueueService.registerHandler(
    "check_due_permission_syncs",
    handleCheckDuePermissionSyncs,
  );
  taskQueueService.registerHandler(
    "check_due_schedule_triggers",
    handleCheckDueScheduleTriggers,
  );
  taskQueueService.registerHandler(
    "schedule_trigger_run_execute",
    handleScheduleTriggerRunExecution,
  );
  taskQueueService.registerHandler("p4_shim_reconcile", handleP4ShimReconcile);
  taskQueueService.registerHandler("audit_log_cleanup", handleAuditLogCleanup);
  taskQueueService.registerHandler(
    "headless_sandbox_cleanup",
    handleHeadlessSandboxCleanup,
  );
  taskQueueService.registerHandler(
    "kb_bm25_stats_refresh",
    handleKbBm25StatsRefresh,
  );
  taskQueueService.registerHandler(
    "content_retention_cleanup",
    handleContentRetentionCleanup,
  );
  taskQueueService.registerHandler(
    "content_encryption_backfill",
    handleContentEncryptionBackfill,
  );
  taskQueueService.registerHandler(
    "check_due_skill_github_syncs",
    handleCheckDueSkillGithubSyncs,
  );
  taskQueueService.registerHandler(
    "check_due_openappa_github_syncs",
    checkDueAppaGithubSyncs,
  );
  taskQueueService.registerHandler("openappa_github_sync", async (payload) => {
    if (typeof payload.organizationId !== "string")
      throw new Error("Missing organizationId");
    await syncAppaGithubPolicy(payload.organizationId);
  });
  taskQueueService.registerHandler(
    "openappa_policy_validation",
    runAutomaticOpenAppaPolicyTests,
  );
  taskQueueService.registerHandler("openappa_effective_policy_recompile", () =>
    openappaBatteriesService.recompileAll(),
  );
  taskQueueService.registerHandler("openappa_unenforced_cleanup", async () => {
    await deleteExpiredUnenforcedRecords();
    await threadStates.deleteExpired();
  });
  taskQueueService.registerHandler("skill_github_sync", handleSkillGithubSync);
  taskQueueService.registerHandler(
    "check_due_plugin_github_syncs",
    handleCheckDuePluginGithubSyncs,
  );
  taskQueueService.registerHandler(
    "plugin_github_sync",
    handlePluginGithubSync,
  );
  taskQueueService.registerHandler(
    "skill_publication_backfill",
    handleSkillPublicationBackfill,
  );
  taskQueueService.registerHandler(
    "interaction_session_preview_backfill",
    handleInteractionSessionPreviewBackfill,
  );
  // Two types for one handler: the periodic check resumes unfinished
  // backfills, the one-off starts a new one immediately. They can't share a
  // type: a queued one-off would make boot skip seeding the periodic task.
  taskQueueService.registerHandler(
    "check_due_model_cost_backfills",
    handleModelCostBackfill,
  );
  taskQueueService.registerHandler(
    "model_cost_backfill",
    handleModelCostBackfill,
  );
  taskQueueService.registerHandler(
    "mcp_tool_description_backfill",
    handleMcpToolDescriptionBackfill,
  );
  taskQueueService.registerHandler("llm_model_sync", handleLlmModelSync);
  taskQueueService.registerHandler("auto_routing_dispatch", () =>
    autoRoutingDispatcher.dispatch(),
  );
  taskQueueService.registerHandler("auto_routing_fit", handleAutoRoutingFit);
  taskQueueService.registerHandler("auto_routing_backfill", () =>
    runBackfill(),
  );
}
