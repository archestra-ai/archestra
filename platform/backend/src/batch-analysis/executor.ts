import logger from "@/logging";
import { AgentModel } from "@/models";
import type {
  BatchAnalysis,
  BatchAnalysisCellFlag,
  BatchAnalysisCitation,
  BatchAnalysisColumn,
  BatchAnalysisRow,
} from "@/types";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import {
  describeModelCallError,
  resolveBatchAnalysisModel,
} from "./llm";
import {
  BATCH_ANALYSIS_RESULT_TAG,
  buildBatchAnalysisSystemPrompt,
  buildBatchAnalysisUserPrompt,
  isQuoteGrounded,
  NOT_FOUND_VALUE,
  parseBatchAnalysisResult,
} from "./prompt";
import { resolveRowSource } from "./source-resolver";

type CellOutcome =
  | {
      columnKey: string;
      ok: true;
      content: string;
      citations: BatchAnalysisCitation[] | null;
      flag: BatchAnalysisCellFlag | null;
    }
  | { columnKey: string; ok: false; error: string };

type RowExecutionResult = {
  outcomes: CellOutcome[];
};

/**
 * Answer every requested column for one row with a single model call.
 *
 * One call per row rather than per cell is the core efficiency of the design:
 * the source text is the expensive part of the prompt, so sending it once and
 * asking N questions costs roughly the same as asking one. It also means a row's
 * answers are mutually consistent — they were produced looking at the same text
 * in the same pass.
 *
 * Never throws for an expected failure. Every column the model could not answer
 * comes back as a failed `CellOutcome`, so the task itself succeeds and the run
 * always finalizes; a thrown error here means genuine infrastructure trouble and
 * is left to the queue's retry.
 */
export async function executeRow(params: {
  analysis: BatchAnalysis;
  row: BatchAnalysisRow;
  columns: BatchAnalysisColumn[];
}): Promise<RowExecutionResult> {
  const { analysis, row, columns } = params;
  const columnKeys = columns.map((column) => column.key);

  if (columns.length === 0) {
    return { outcomes: [] };
  }

  const resolved = await resolveRowSource({
    source: row.source,
    organizationId: analysis.organizationId,
    actingUserId: analysis.createdBy,
  });
  if (!resolved.ok) {
    return { outcomes: failAll(columnKeys, resolved.error) };
  }
  const { text: sourceText, truncated } = resolved.source;

  if (sourceText.trim().length === 0) {
    // An empty source is a real, reportable outcome — not something to ask a
    // model about. Silently answering N/A here would hide an ingestion problem.
    return {
      outcomes: failAll(columnKeys, "Source has no extractable text"),
    };
  }

  const agent = await AgentModel.findById(analysis.agentId);
  if (!agent) {
    return { outcomes: failAll(columnKeys, "Analysis agent no longer exists") };
  }

  const resolvedModel = await resolveBatchAnalysisModel({
    agent,
    organizationId: analysis.organizationId,
    userId: analysis.createdBy,
    source: "batch_analysis:cell",
  });
  if (!resolvedModel.ok) {
    return { outcomes: failAll(columnKeys, resolvedModel.error) };
  }
  const { model } = resolvedModel;

  let raw: string | null;
  try {
    raw = await generateTaggedText({
      model,
      tag: BATCH_ANALYSIS_RESULT_TAG,
      system: buildBatchAnalysisSystemPrompt(),
      prompt: buildBatchAnalysisUserPrompt({
        label: row.label,
        sourceText,
        columns,
        truncated,
      }),
      // Extraction, not composition — low temperature keeps repeat runs over the
      // same source comparable, which matters when a grid is re-run.
      temperature: resolvedModel.temperature,
      maxOutputTokens: 4096,
    });
  } catch (error) {
    const message = describeModelCallError(error);
    logger.warn(
      { rowId: row.id, analysisId: analysis.id, error: message },
      "[BatchAnalysis] Model call failed for row",
    );
    return { outcomes: failAll(columnKeys, `Model call failed: ${message}`) };
  }

  if (raw === null) {
    return {
      outcomes: failAll(columnKeys, "Model did not return a usable result"),
    };
  }

  const parsed = parseBatchAnalysisResult(raw);
  if (!parsed.ok) {
    return { outcomes: failAll(columnKeys, parsed.error) };
  }

  return {
    outcomes: columns.map((column): CellOutcome => {
      const answer = parsed.answers.get(column.key);
      if (!answer) {
        // Asked for, not returned. Reporting this per column rather than failing
        // the row keeps a partially-useful response usable.
        return {
          columnKey: column.key,
          ok: false,
          error: "Model did not return an answer for this column",
        };
      }

      const citations = buildCitations({
        answer,
        column,
        sourceText,
      });

      return {
        columnKey: column.key,
        ok: true,
        content: answer.value,
        // Only opted-in columns keep a flag — a model volunteering one for a
        // plain extraction column is discarded, not stored.
        flag: column.flag ? answer.flag : null,
        citations,
      };
    }),
  };
}

/**
 * Keep only quotes that actually occur in the source. An ungrounded quote is a
 * fabrication, and dropping it costs nothing — the answer still stands, it just
 * arrives without a citation rather than with a fake one.
 */
function buildCitations(params: {
  answer: { value: string; quote: string | null };
  column: BatchAnalysisColumn;
  sourceText: string;
}): BatchAnalysisCitation[] | null {
  const { answer, column, sourceText } = params;
  if (answer.value === NOT_FOUND_VALUE) {
    return null;
  }

  // An `exact_quote` column's answer IS the citation, so it is held to the same
  // grounding check as any other quote.
  const candidate =
    column.format === "exact_quote" ? answer.value : answer.quote;
  if (!candidate) {
    return null;
  }

  if (!isQuoteGrounded({ quote: candidate, sourceText })) {
    logger.debug(
      { columnKey: column.key },
      "[BatchAnalysis] Dropping a quote that does not appear in the source",
    );
    return null;
  }

  return [{ quote: candidate }];
}

function failAll(columnKeys: string[], error: string): CellOutcome[] {
  return columnKeys.map((columnKey) => ({ columnKey, ok: false, error }));
}

