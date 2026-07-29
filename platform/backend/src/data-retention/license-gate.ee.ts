// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import config from "@/config";
import logger from "@/logging";

/**
 * Boot-time gate for the enterprise data-retention feature.
 *
 * Fails startup — rather than silently skipping deletion — when any retention
 * window is configured without an active enterprise license: an operator who
 * configured retention may be relying on it for a compliance requirement, so
 * "configured but not running" must be loud.
 *
 * Also warns when the interaction window is shorter than the longest
 * cost-limit window: default per-user limits aggregate the `interactions`
 * table over rolling/calendar-month periods, so deleting rows inside that
 * horizon can under-count usage against limits.
 */
export function assertRetentionConfigLicensed(): void {
  const { llmLogsDays, mcpLogsDays, chatConversationsDays } = config.retention;
  const anyConfigured =
    llmLogsDays > 0 || mcpLogsDays > 0 || chatConversationsDays > 0;
  if (!anyConfigured) return;

  if (!config.enterpriseFeatures.core) {
    throw new Error(
      "Data retention (ARCHESTRA_LLM_LOGS_RETENTION_DAYS / " +
        "ARCHESTRA_MCP_LOGS_RETENTION_DAYS / " +
        "ARCHESTRA_CHAT_CONVERSATIONS_RETENTION_DAYS) requires an enterprise " +
        "license. Unset these variables or contact sales@archestra.ai.",
    );
  }

  if (llmLogsDays > 0 && llmLogsDays < 32) {
    logger.warn(
      { llmLogsDays },
      "ARCHESTRA_LLM_LOGS_RETENTION_DAYS is shorter than the longest " +
        "cost-limit window (a calendar month): default per-user token limits " +
        "may under-count usage. Consider a window of at least 32 days.",
    );
  }
}
