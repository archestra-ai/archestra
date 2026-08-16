// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { generateText } from "ai";
import { createDirectLLMModel } from "@/clients/llm-client";
import config from "@/config";
import type {
  DocReviewCitation,
  DocReviewColumn,
  DocReviewOutputFormat,
} from "@/database/schemas/doc-review.ee";
import logger from "@/logging";
import type { KbDocument } from "@/types";
import { resolveRerankerConfig } from "./kb-llm-client";

export type CellExecutionResult = {
  value: unknown;
  citations: DocReviewCitation[];
  tokensUsed?: number;
};

const SYSTEM_PROMPT_TEMPLATE = `You are a precise document review system. You are given a document and a specific question or field to extract.

Answer the question strictly based on the document content provided.
Output format required: {output_format_instruction}

Format your output into two sections:
[ANSWER]
<The extracted answer adhering to the required format>
[/ANSWER]

[CITATIONS]
<List 1 to 3 verbatim quotes from the document supporting your answer, one per line>
[/CITATIONS]`;

function getOutputFormatInstruction(format: DocReviewOutputFormat): string {
  switch (format) {
    case "yes_no":
      return 'Respond with either "YES" or "NO" (or "UNKNOWN" if not stated in the document).';
    case "date":
      return 'Respond with a date in YYYY-MM-DD format (or "UNKNOWN" if no date is found).';
    case "number":
      return 'Respond with only the numeric value (e.g. 30, 100.50, or "UNKNOWN").';
    case "list":
      return 'Respond with a bulleted list of extracted items, one per line.';
    case "json":
      return "Respond with valid JSON object or array matching the requested schema.";
    case "text":
    default:
      return "Respond with a clear, concise prose explanation or direct extract.";
  }
}

function parseAnswerValue(
  rawAnswer: string,
  format: DocReviewOutputFormat,
): unknown {
  const trimmed = rawAnswer.trim();
  switch (format) {
    case "yes_no": {
      const upper = trimmed.toUpperCase();
      if (upper.includes("YES")) return true;
      if (upper.includes("NO")) return false;
      return trimmed;
    }
    case "number": {
      const numMatch = trimmed.match(/-?\d+(?:\.\d+)?/);
      if (numMatch) return Number(numMatch[0]);
      return trimmed;
    }
    case "date": {
      const dateMatch = trimmed.match(/\b\d{4}-\d{2}-\d{2}\b/);
      if (dateMatch) return dateMatch[0];
      return trimmed;
    }
    case "list": {
      const lines = trimmed
        .split("\n")
        .map((l) => l.replace(/^[-*•\d+.]\s*/, "").trim())
        .filter(Boolean);
      return lines.length > 0 ? lines : [trimmed];
    }
    case "json": {
      try {
        const jsonMatch = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
      } catch {
        // Fall back to string if JSON parsing fails
      }
      return trimmed;
    }
    case "text":
    default:
      return trimmed;
  }
}

function parseCitations(
  citationsBlock: string,
  document: KbDocument,
): DocReviewCitation[] {
  if (!citationsBlock.trim()) return [];

  const quotes = citationsBlock
    .split("\n")
    .map((l) => l.replace(/^[-\d+."']+\s*/, "").replace(/["']+$/, "").trim())
    .filter((q) => q.length > 5);

  return quotes.map((quote) => {
    const startOffset = document.content.indexOf(quote);
    return {
      quote,
      documentId: document.id,
      title: document.title,
      sourceUrl: document.sourceUrl,
      startOffset: startOffset >= 0 ? startOffset : undefined,
      endOffset:
        startOffset >= 0 ? startOffset + quote.length : undefined,
    };
  });
}

export async function executeReviewCell(params: {
  organizationId: string;
  document: KbDocument;
  column: DocReviewColumn;
}): Promise<CellExecutionResult> {
  const { organizationId, document, column } = params;

  // Resolve LLM model for the org
  let llmModel: any = null;
  try {
    const rerankerConfig = await resolveRerankerConfig(organizationId);
    if (rerankerConfig && rerankerConfig.kind === "llm") {
      llmModel = rerankerConfig.llmModel;
    }
  } catch (err) {
    logger.debug(
      { organizationId, err },
      "[DocReviewRunner] Could not resolve org reranker model, attempting fallback",
    );
  }

  // Fall back to default Ollama / OpenAI model if none configured
  if (!llmModel) {
    llmModel = createDirectLLMModel({
      provider: "openai",
      modelName: "gpt-4o-mini",
    });
  }

  const system = SYSTEM_PROMPT_TEMPLATE.replace(
    "{output_format_instruction}",
    getOutputFormatInstruction(column.outputFormat),
  );

  const prompt = `DOCUMENT TITLE: ${document.title}
${document.sourceUrl ? `SOURCE URL: ${document.sourceUrl}\n` : ""}
DOCUMENT CONTENT:
${document.content.slice(0, 100_000)}

---
QUESTION / INSTRUCTION:
${column.prompt}`;

  const result = await generateText({
    model: llmModel,
    system,
    prompt,
  });

  const fullText = result.text;
  let rawAnswer = fullText;
  let citationsBlock = "";

  const answerMatch = fullText.match(/\[ANSWER\]([\s\S]*?)\[\/ANSWER\]/i);
  if (answerMatch) {
    rawAnswer = answerMatch[1].trim();
  }

  const citationMatch = fullText.match(/\[CITATIONS\]([\s\S]*?)\[\/CITATIONS\]/i);
  if (citationMatch) {
    citationsBlock = citationMatch[1].trim();
  }

  const parsedValue = parseAnswerValue(rawAnswer, column.outputFormat);
  const citations = parseCitations(citationsBlock, document);

  return {
    value: parsedValue,
    citations,
    tokensUsed: result.usage?.totalTokens,
  };
}
