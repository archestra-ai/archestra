import type { TextSearchLanguage } from "@archestra/shared";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { chunkDocument } from "./chunker";
import {
  collapseParentSiblings,
  resolveParentPassages,
} from "./parent-passage";
import { countTokens, getEncoding } from "./tokenizer";

/**
 * What parent/child indexing buys, and what it costs, measured rather than
 * asserted.
 *
 * The premise under test is the one from the issue: a corpus indexed at a
 * single size answers precise lookups and broad questions with the same
 * compromise. The specific fact — a port number — is a handful of tokens inside
 * a passage of configuration that shares most of its vocabulary with every
 * other passage, so at passage size the fact is a rounding error in whatever
 * the retriever matches on.
 *
 * Signal density (relevant tokens / tokens in the unit that gets matched) is
 * the stand-in for embedding dilution here: a real embedding call cannot run in
 * a unit test, and density is the property that drives it — the smaller the
 * share of a chunk its one distinguishing fact holds, the less that fact moves
 * the vector. Rank is measured for real, against the same PostgreSQL full-text
 * search the keyword lane uses.
 */

const PORT_FACT = "The ingest service listens on port 8080.";
const PORT_QUERY = "ingest service listen port";

/**
 * The passage the fact lives in: enough surrounding explanation that a reader
 * who gets only the fact learns nothing, which is why retrieval has to hand
 * back the passage and not the sentence.
 */
const INGEST_PASSAGE = [
  "The ingest pipeline receives batched telemetry from every edge collector.",
  PORT_FACT,
  "Batches are validated, deduplicated against the last hour of ingest, and written to the durable queue.",
  "A failed batch is retried three times before it is parked on the dead-letter topic for manual review.",
].join(" ");

/**
 * Neighbouring configuration that shares the query's vocabulary — "service",
 * "listens", "port" — so the query cannot be answered by a single rare word.
 */
const DISTRACTOR_PASSAGES = Array.from(
  { length: 10 },
  (_, index) =>
    `The reporting service ${index} listens on port 90${index}0 and forwards accepted records onward. ` +
    `Its retry policy, batching window, and queue depth are configured for the reporting workload rather than for ingest volume. ` +
    `Operators tune the reporting service ${index} independently of every other service in this document.`,
);

const DOCUMENT_TITLE = "Platform service configuration";
const DOCUMENT_CONTENT = [
  ...DISTRACTOR_PASSAGES.slice(0, 5),
  INGEST_PASSAGE,
  ...DISTRACTOR_PASSAGES.slice(5),
].join("\n\n");

const PARENT_TOKENS = 512;
const CHILD_TOKENS = 128;

describe("parent/child indexing quality and cost", () => {
  test("measures the precision gain beside the extra vectors it costs", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const organization = await makeOrganization();
    const knowledgeBase = await makeKnowledgeBase(organization.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      organization.id,
    );

    const singlePass = await evaluate({
      childMaxTokens: 0,
      organizationId: organization.id,
      connectorId: connector.id,
      ftsLanguage: connector.ftsLanguage,
      hash: "quality-single-pass",
    });
    const parentChild = await evaluate({
      childMaxTokens: CHILD_TOKENS,
      organizationId: organization.id,
      connectorId: connector.id,
      ftsLanguage: connector.ftsLanguage,
      hash: "quality-parent-child",
    });

    // --- Quality -------------------------------------------------------
    //
    // Both find the fact — this document is small enough that single-pass
    // retrieval is not broken, only blunt. What changes is how much of the
    // matched unit is the thing that was asked about: a tenth of a passage
    // becomes a third of a child chunk.
    expect(singlePass.factRank).toBe(1);
    expect(parentChild.factRank).toBe(1);
    expect(parentChild.signalDensity).toBeGreaterThan(
      singlePass.signalDensity * 2,
    );

    // ...and the density gain is not paid for in lost context. The passage
    // handed to the model is the same one single-pass retrieval would have
    // returned, explanation intact.
    expect(parentChild.returnedPassage).toContain(PORT_FACT);
    expect(parentChild.returnedPassage).toContain("dead-letter topic");
    // Compared modulo surrounding whitespace: a single-pass chunk keeps
    // whatever trailing newlines its boundary fell on, while a reassembled one
    // ends at its last child's last character. Not text the model reads.
    expect(parentChild.returnedPassage.trim()).toBe(
      singlePass.returnedPassage.trim(),
    );

    // --- Cost ----------------------------------------------------------
    //
    // The multiple lands on the vector count, not on the embedding bill. The
    // children tile the same text the parents did, so the tokens sent to the
    // embedding provider barely move; what grows is how many rows carry a
    // vector, which is index size and ANN work.
    expect(parentChild.chunkCount / singlePass.chunkCount).toBeGreaterThan(2);
    expect(parentChild.embeddedTokens / singlePass.embeddedTokens).toBeLessThan(
      1.3,
    );

    // Passage count is untouched, which is what keeps contextual retrieval —
    // one generation call per passage — costing exactly what it did before.
    expect(parentChild.passageCount).toBe(singlePass.chunkCount);

    // Recorded for the issue's cost/quality ledger. Pinned so a future change
    // to chunking has to restate the trade rather than drift through it.
    expect({
      chunkCountMultiple: round(parentChild.chunkCount / singlePass.chunkCount),
      embeddedTokenMultiple: round(
        parentChild.embeddedTokens / singlePass.embeddedTokens,
      ),
      signalDensityMultiple: round(
        parentChild.signalDensity / singlePass.signalDensity,
      ),
    }).toEqual({
      // 2 passages become 6 children: 3x the rows carrying a vector.
      chunkCountMultiple: 3,
      // ...for 4% more tokens sent to the embedding provider. The children
      // tile the same text the passages did; the only new tokens are the title
      // prefix each one repeats so it can still be embedded standalone. The
      // cost of this pattern is index size and ANN work, NOT the embedding
      // bill — which is the opposite of what doubling the chunk count suggests.
      embeddedTokenMultiple: 1.04,
      // The fact went from 2% of the matched unit to 8% of it.
      signalDensityMultiple: 4.08,
    });
  });

  test("sibling hits collapse so one passage never fills the result set", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    // The cost of matching on small chunks: a query that hits one sentence of a
    // passage tends to hit its neighbours too, and every one of them resolves
    // to the same passage. Left alone that returns the same text repeatedly and
    // spends the whole result set on one document.
    const organization = await makeOrganization();
    const knowledgeBase = await makeKnowledgeBase(organization.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      organization.id,
    );

    const { chunkRows } = await ingest({
      childMaxTokens: CHILD_TOKENS,
      organizationId: organization.id,
      connectorId: connector.id,
      ftsLanguage: connector.ftsLanguage,
      hash: "quality-collapse",
    });

    const matches = await KbChunkModel.fullTextSearch({
      connectorIds: [connector.id],
      queryText: "reporting service listens port",
      languages: [connector.ftsLanguage],
      userAcl: [],
      bypassAcl: true,
      limit: chunkRows.length,
    });

    const collapsed = collapseParentSiblings(matches);
    const passagesInMatches = new Set(
      matches.map((m) => `${m.documentId}:${m.parentIndex}`),
    );

    // Several children of one passage matched...
    expect(matches.length).toBeGreaterThan(passagesInMatches.size);
    // ...and exactly one result per passage survives, in rank order.
    expect(collapsed).toHaveLength(passagesInMatches.size);
    expect(new Set(collapsed.map((c) => c.parentIndex)).size).toBe(
      collapsed.length,
    );
  });
});

// ===== Harness =====

async function ingest(params: {
  childMaxTokens: number;
  organizationId: string;
  connectorId: string;
  ftsLanguage: TextSearchLanguage;
  hash: string;
}) {
  const document = await KbDocumentModel.create({
    connectorId: params.connectorId,
    organizationId: params.organizationId,
    title: DOCUMENT_TITLE,
    content: DOCUMENT_CONTENT,
    contentHash: params.hash,
    embeddingStatus: "pending",
  });

  const chunks = await chunkDocument({
    title: DOCUMENT_TITLE,
    content: DOCUMENT_CONTENT,
    maxTokens: PARENT_TOKENS,
    childMaxTokens: params.childMaxTokens,
  });

  await KbChunkModel.insertMany(
    chunks.map((chunk) => ({
      documentId: document.id,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      parentIndex: chunk.parentIndex,
      ftsLanguage: params.ftsLanguage,
      acl: ["org:*"],
    })),
  );

  return { document, chunks, chunkRows: chunks };
}

async function evaluate(params: {
  childMaxTokens: number;
  organizationId: string;
  connectorId: string;
  ftsLanguage: TextSearchLanguage;
  hash: string;
}) {
  const { document, chunks } = await ingest(params);
  const encoding = getEncoding();

  const matches = await KbChunkModel.fullTextSearch({
    connectorIds: [params.connectorId],
    queryText: PORT_QUERY,
    languages: [params.ftsLanguage],
    userAcl: [],
    bypassAcl: true,
    limit: chunks.length,
  });
  const documentMatches = matches.filter((m) => m.documentId === document.id);

  const factRank =
    documentMatches.findIndex((match) => match.content.includes(PORT_FACT)) + 1;
  const factMatch = documentMatches[factRank - 1];

  // What the caller ends up reading, through the real resolution path.
  const [served] = await resolveParentPassages({
    results: collapseParentSiblings([factMatch]),
    userAcl: [],
    bypassAcl: true,
  });

  return {
    chunkCount: chunks.length,
    passageCount: new Set(
      chunks.map((chunk) => chunk.parentIndex ?? chunk.chunkIndex),
    ).size,
    // Every chunk is embedded once, and its stored content is what goes to the
    // provider — so this is the ingest embedding bill for this document.
    embeddedTokens: chunks.reduce(
      (total, chunk) => total + chunk.tokenCount,
      0,
    ),
    factRank,
    signalDensity:
      countTokens(encoding, PORT_FACT) /
      countTokens(encoding, factMatch.content),
    returnedPassage: served.content,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
