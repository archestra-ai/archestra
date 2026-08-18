import { z } from "zod";
import type { LLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import type {
  BatchAnalysis,
  BatchAnalysisCell,
  BatchAnalysisRow,
} from "@/types";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import { describeModelCallError } from "./llm";

const GRID_CHAT_ANSWER_TAG = "grid_answer";

/**
 * Character budget for the serialized grid. The schema ceiling (500 rows × 50
 * columns) would dwarf any context window; the serialization stops at the
 * budget and says how many rows it dropped, so the model never silently
 * answers over a truncated table it believes is whole.
 */
const GRID_CHAT_MAX_CHARS = 150_000;

interface GridChatReference {
  rowId: string;
  columnKey: string;
}

type GridChatResult =
  | { ok: true; answer: string; references: GridChatReference[] }
  | { ok: false; error: string; upstream?: boolean };

/**
 * One-shot Q&A over the extracted grid — the table itself, not the source
 * documents. References returned by the model are validated against the exact
 * cells that were serialized, so a hallucinated or foreign coordinate can
 * never reach the client.
 */
export async function askGrid(params: {
  model: LLMModel;
  temperature: number | undefined;
  question: string;
  analysis: BatchAnalysis;
  rows: BatchAnalysisRow[];
  cells: BatchAnalysisCell[];
}): Promise<GridChatResult> {
  const { serialized, validRefs } = serializeGrid({
    analysis: params.analysis,
    rows: params.rows,
    cells: params.cells,
  });

  let raw: string | null;
  try {
    raw = await generateTaggedText({
      model: params.model,
      tag: GRID_CHAT_ANSWER_TAG,
      system: buildGridChatSystemPrompt(),
      prompt: [
        `ANALYSIS: ${params.analysis.name}`,
        "",
        "<grid>",
        serialized,
        "</grid>",
        "",
        `QUESTION: ${params.question}`,
      ].join("\n"),
      temperature: params.temperature,
      maxOutputTokens: 2048,
    });
  } catch (error) {
    // A provider failure is the provider's failure: surface its message and
    // let the route relay it as an upstream error rather than a bare 500.
    return {
      ok: false,
      upstream: true,
      error: describeModelCallError(error),
    };
  }
  if (raw === null) {
    return { ok: false, error: "The model returned no usable answer" };
  }

  const parsed = parseGridChatResult(raw);
  if (!parsed.ok) return parsed;

  const references = parsed.references.filter((reference) => {
    const known = validRefs.has(`${reference.rowId}:${reference.columnKey}`);
    if (!known) {
      logger.debug(
        { reference },
        "[BatchAnalysis] Dropping a grid-chat reference outside the serialized grid",
      );
    }
    return known;
  });
  return { ok: true, answer: parsed.answer, references };
}

function buildGridChatSystemPrompt(): string {
  return [
    "You answer questions about a table of extracted answers (the grid).",
    "Each grid row is one source document; each cell is an answer extracted from it, some carrying a triage flag.",
    "Answer ONLY from the grid contents. Never use outside knowledge, and say so when the grid does not answer the question.",
    "",
    `Reply with a single JSON object wrapped in <${GRID_CHAT_ANSWER_TAG}></${GRID_CHAT_ANSWER_TAG}> tags:`,
    '  - "answer": your answer in plain prose',
    '  - "references": the cells your answer relies on, as [{"rowId": "...", "columnKey": "..."}] — use the exact ids shown in the grid, or [] when none apply',
    "",
    "Emit no text outside the tags.",
  ].join("\n");
}

// ===== Internal =====

function serializeGrid(params: {
  analysis: BatchAnalysis;
  rows: BatchAnalysisRow[];
  cells: BatchAnalysisCell[];
}): { serialized: string; validRefs: Set<string> } {
  const cellsByRowAndColumn = new Map(
    params.cells.map((cell) => [`${cell.rowId}:${cell.columnKey}`, cell]),
  );
  const validRefs = new Set<string>();

  const columnHeader = params.analysis.columns
    .map((column) => `  [${column.key}] ${column.name}`)
    .join("\n");
  const lines: string[] = [`COLUMNS:\n${columnHeader}`, "", "ROWS:"];
  let budget = GRID_CHAT_MAX_CHARS - lines.join("\n").length;
  let omitted = 0;

  for (const row of params.rows) {
    const rowRefs: string[] = [];
    const cellLines = params.analysis.columns.map((column) => {
      const key = `${row.id}:${column.key}`;
      const cell = cellsByRowAndColumn.get(key);
      if (cell?.status === "done") rowRefs.push(key);
      const flag = cell?.flag ? ` (flag: ${cell.flag})` : "";
      const value =
        cell?.status === "done"
          ? (cell.content ?? "")
          : `(${cell?.status ?? "pending"})`;
      return `  [${column.key}] ${value}${flag}`;
    });
    const block = [`row ${row.id} — ${row.label}:`, ...cellLines].join("\n");
    if (block.length + 1 > budget) {
      omitted += 1;
      continue;
    }
    budget -= block.length + 1;
    lines.push(block);
    // Only rows the model actually received are citable — a reference to an
    // omitted row would be "validated" against text that was never sent.
    for (const key of rowRefs) validRefs.add(key);
  }
  if (omitted > 0) {
    lines.push(
      `NOTE: ${omitted} row(s) were omitted because the grid exceeds the size budget. Say so if the question may depend on them.`,
    );
  }
  return { serialized: lines.join("\n"), validRefs };
}

const GridChatPayloadSchema = z.object({
  answer: z.string().min(1),
  references: z
    .array(z.object({ rowId: z.string(), columnKey: z.string() }))
    .catch([]),
});

function parseGridChatResult(
  raw: string,
):
  | { ok: true; answer: string; references: GridChatReference[] }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // A model answering in prose despite the contract still answered — keep
    // the text, drop the references rather than failing the question.
    return { ok: true, answer: raw.trim(), references: [] };
  }
  const validated = GridChatPayloadSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, error: "The model's answer had an unexpected shape" };
  }
  return {
    ok: true,
    answer: validated.data.answer,
    references: validated.data.references,
  };
}
