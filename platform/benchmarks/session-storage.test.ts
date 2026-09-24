import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
// zstdCompressSync/zstdDecompressSync require Node 24 (repo engines allow
// >=20; the local pin is Node 24), so this opt-in benchmark only runs where
// the pin is honored.
import {
  gunzipSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import config from "@/config";
import {
  _resetContentKeys,
  decryptContentValue,
  encryptContentValue,
  isContentEnvelope,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed; the benchmark measures the enterprise at-rest codec, which is a no-op without a secret
} from "@/content-encryption/index.ee";
import db from "@/database";
import { test } from "@/test";
import type { InsertInteraction } from "@/types";
import InteractionModel from "../backend/src/models/interaction";
import InteractionDeltaManager from "../backend/src/models/interaction-delta-manager";
import { CLAUDE_METADATA_SESSION_SOURCE } from "../shared/interactions/session-source";

// Run from platform/:
// ARCHESTRA_DATABASE_URL=postgresql://inert:inert@127.0.0.1:1/inert pnpm --dir backend exec vitest run --config vitest.benchmark.config.ts
// The unreachable URL satisfies config parsing; tests use only their own PGlite.
// This is a separate measurement suite, not a CI performance threshold. No production data is read.
//
// At-rest caveats (see the `caveats` array in the JSON report):
// - Archestra has NO compression at rest for interaction payloads. The at-rest
//   feature for interactions.request/processed_request is enterprise AES-256-GCM
//   content encryption (ARCHESTRA_CONTENT_ENCRYPTION_SECRET, content-encryption/),
//   which INFLATES bytes (base64url envelope + JSON wrapper). The `contentEncryption`
//   fields measure that real on/off through InteractionModel.create.
// - The platform's only production compression-at-rest codec is node:zlib gzip
//   (default level) over 256 KiB chunks, used for agent-run transcripts
//   (backend/src/services/agent-runtime/transcript-store.ts). It is never applied
//   to interactions; `transcriptCodecGzipBytes` is a what-if on matched input.

const RESPONSE = {
  id: "msg_benchmark",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

test("compare stored requests with full snapshots and compression", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();
  const results = [];
  for (const { name, turns, movingBreakpoint, editedHistory } of [
    { name: "stable-12", turns: 12 },
    { name: "stable-48", turns: 48 },
    { name: "stable-96", turns: 96 },
    { name: "moving-breakpoint-48", turns: 48, movingBreakpoint: true },
    { name: "edited-history-48", turns: 48, editedHistory: true },
  ]) {
    InteractionDeltaManager.reset();
    const requests = makeRequests(turns, movingBreakpoint, editedHistory);
    const plain: Buffer[] = [];
    const delta: Buffer[] = [];
    const appendOnly: Buffer[] = [];
    const appendEvents: Array<{
      request: unknown;
      processedRequest: unknown;
    }> = [];
    const rows = [];
    const writeMs = [];
    let warmMismatches = 0;

    for (const [index, request] of requests.entries()) {
      const data: InsertInteraction = {
        profileId: agent.id,
        sessionId: `bench-${name}`,
        sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
        type: "anthropic:messages",
        request: request as InsertInteraction["request"],
        processedRequest: request as InsertInteraction["processedRequest"],
        response: RESPONSE as InsertInteraction["response"],
      };
      const started = process.hrtime.bigint();
      const row = await InteractionModel.create(data);
      writeMs.push(msSince(started));
      rows.push(row);

      // Count only the two request fields plus delta navigation metadata. Other
      // interaction columns are common to every option and are excluded.
      plain.push(
        Buffer.from(JSON.stringify({ request, processedRequest: request })),
      );
      const previousLength = requests[index - 1]?.messages.length ?? 0;
      const event =
        index === 0
          ? { request, processedRequest: request }
          : {
              request: { messages: request.messages.slice(previousLength) },
              processedRequest: {
                messages: request.messages.slice(previousLength),
              },
            };
      appendOnly.push(Buffer.from(JSON.stringify(event)));
      appendEvents.push(event);
      delta.push(
        Buffer.from(
          JSON.stringify({
            request: row.request,
            processedRequest: row.processedRequest,
            parentId: row.parentId,
            threadId: row.threadId,
            requestSharedPrefix: row.requestSharedPrefix,
            processedRequestSharedPrefix: row.processedRequestSharedPrefix,
            requestLastMessageIdx: row.requestLastMessageIdx,
            requestLastMessageHash: row.requestLastMessageHash,
          }),
        ),
      );
      const warm = await InteractionDeltaManager.reconstructRow(row);
      if (
        !isDeepStrictEqual(warm.request, request) ||
        !isDeepStrictEqual(warm.processedRequest, request)
      ) {
        warmMismatches++;
      }
    }

    let coldMismatches = 0;
    let appendMismatches = 0;
    let appended: (typeof requests)[number] | null = null;
    for (let i = 0; i < rows.length; i++) {
      InteractionDeltaManager.reset();
      const cold = await InteractionDeltaManager.reconstructRow(rows[i]);
      if (
        !isDeepStrictEqual(cold.request, requests[i]) ||
        !isDeepStrictEqual(cold.processedRequest, requests[i])
      ) {
        coldMismatches++;
      }
      const event = JSON.parse(appendOnly[i].toString()) as {
        request: (typeof requests)[number];
        processedRequest: (typeof requests)[number];
      };
      if (i === 0) {
        appended = event.request;
      } else {
        const previous: (typeof requests)[number] = appended ?? requests[0];
        appended = {
          ...previous,
          messages: [...previous.messages, ...event.request.messages],
        };
      }
      if (
        !isDeepStrictEqual(appended, requests[i]) ||
        !isDeepStrictEqual(
          i === 0 ? event.processedRequest : appended,
          requests[i],
        )
      ) {
        appendMismatches++;
      }
    }

    const coldReadMs = [];
    const warmReadMs = [];
    const tip = rows.at(-1);
    if (!tip) throw new Error("Missing benchmark tip");
    for (let i = 0; i < 7; i++) {
      InteractionDeltaManager.reset();
      const started = process.hrtime.bigint();
      await InteractionDeltaManager.reconstructRow(tip);
      coldReadMs.push(msSince(started));
      const warmStarted = process.hrtime.bigint();
      await InteractionDeltaManager.reconstructRow(tip);
      warmReadMs.push(msSince(warmStarted));
    }

    const contentEncryption = await measureContentEncryptionAtRest({
      profileId: agent.id,
      name,
      requests,
      appendEvents,
    });

    results.push({
      workload: name,
      rows: rows.length,
      finalMessages: requests.at(-1)?.messages.length,
      chainedRows: rows.filter((row) => row.parentId !== null).length,
      rawBytes: {
        full: sumBytes(plain),
        delta: sumBytes(delta),
        appendOnly: sumBytes(appendOnly),
      },
      gzipBytes: {
        full: compressedBytes(plain, gzipSync),
        delta: compressedBytes(delta, gzipSync),
        appendOnly: compressedBytes(appendOnly, gzipSync),
      },
      zstdBytes: {
        full: compressedBytes(plain, zstdCompressSync),
        delta: compressedBytes(delta, zstdCompressSync),
        appendOnly: compressedBytes(appendOnly, zstdCompressSync),
      },
      wholeSessionZstdBytes: {
        full: wholeSessionBytes(plain),
        delta: wholeSessionBytes(delta),
        appendOnly: wholeSessionBytes(appendOnly),
      },
      transcriptCodecGzipBytes: {
        full: transcriptCodecBytes(plain),
        delta: transcriptCodecBytes(delta),
        appendOnly: transcriptCodecBytes(appendOnly),
      },
      contentEncryption,
      medianWriteMs: median(writeMs),
      medianWarmTipReadMs: median(warmReadMs),
      medianColdTipReadMs: median(coldReadMs),
      warmMismatches,
      coldMismatches,
      appendMismatches,
      lossless: warmMismatches === 0 && coldMismatches === 0,
      codecMs: {
        fullGzip: codecTime(plain, gzipSync, gunzipSync),
        fullZstd: codecTime(plain, zstdCompressSync, zstdDecompressSync),
        deltaGzip: codecTime(delta, gzipSync, gunzipSync),
        deltaZstd: codecTime(delta, zstdCompressSync, zstdDecompressSync),
        transcriptCodecGzip: transcriptCodecTime(plain),
        contentEncryption: contentEncryption.codecMs,
      },
    });
  }

  process.stdout.write(
    `SESSION_STORAGE_BENCHMARK_JSON=${JSON.stringify({
      node: process.version,
      samplesPerCodec: 7,
      caveats: [
        "Archestra has no compression at rest for interaction payloads; the at-rest feature for interactions.request/processed_request is enterprise AES-256-GCM content encryption (ARCHESTRA_CONTENT_ENCRYPTION_SECRET), which inflates rather than compresses (base64url envelope + JSON wrapper).",
        "contentEncryption.deltaViaModelBytes is measured through InteractionModel.create against the test PGlite database with encryption enabled; the full/appendOnly variants apply the exact encryptContentValue codec to the same payloads off-path.",
        "Delta encoding stays active under content encryption (parent resolution uses plaintext hash columns), so deltaViaModelBytes is the on-versus-off comparison for the delta strategy.",
        "The append-only event sketch cannot reconstruct changed earlier messages. Its adversarial-workload byte counts are invalid as lossless storage comparisons.",
        "transcriptCodecGzipBytes uses the platform's only production compression-at-rest codec (node:zlib gzip, default level, 256 KiB chunks - backend/src/services/agent-runtime/transcript-store.ts), which production applies to agent-run transcripts only, never to interactions; treat as what-if sizing on matched input.",
      ],
      results,
    })}\n`,
  );
  for (const result of results) {
    if (!result.lossless) {
      process.stderr.write(
        `INVALID DELTA REPLAY: ${result.workload} has ${result.warmMismatches} warm and ${result.coldMismatches} cold mismatches.\n`,
      );
    }
    if (result.appendMismatches !== 0) {
      process.stderr.write(
        `APPEND-ONLY BASELINE IS LOSSY: ${result.workload} has ${result.appendMismatches} mismatches and cannot be compared as lossless storage.\n`,
      );
    }
    const encrypted = result.contentEncryption;
    if (
      !encrypted.allRowsEncrypted ||
      encrypted.warmMismatches !== 0 ||
      encrypted.coldMismatches !== 0
    ) {
      process.stderr.write(
        `INVALID ENCRYPTED DELTA REPLAY: ${result.workload} has allRowsEncrypted=${encrypted.allRowsEncrypted}, ${encrypted.warmMismatches} warm and ${encrypted.coldMismatches} cold mismatches.\n`,
      );
    }
  }
  if (results.some((result) => !result.lossless)) {
    throw new Error(
      "A delta workload failed exact warm or cold reconstruction",
    );
  }
  if (results.slice(0, 3).some((result) => result.appendMismatches !== 0)) {
    throw new Error("An append-only baseline failed on unchanged history");
  }
  if (
    results.some(
      (result) =>
        !result.contentEncryption.allRowsEncrypted ||
        result.contentEncryption.warmMismatches !== 0 ||
        result.contentEncryption.coldMismatches !== 0,
    )
  ) {
    throw new Error(
      "Encrypted rows were not all envelopes or exact reconstruction failed",
    );
  }
}, 240_000);

// === Claude-shaped 2026 coding-agent scenarios ==============================
//
// Provenance (public anchors; these are scenario anchors, NOT claimed industry
// averages):
// - TraceLab v0.0.2 (https://github.com/uw-syfi/TraceLab), DuckDB asset SHA256
//   a7bab286bc640844560850965ccf47975cf66407154132abaab90f27ec9be744. The
//   released dataset holds 8,058 sessions; the prior paper analyzed 4,265 - do
//   not conflate the two counts. Sanitized full-dataset measured content chars:
//   tool_result p50 407 / p90 8,219 / p99 40,151; user_message p50 372 /
//   p90 8,381; assistant text p50 204; tool input p50 197; tool results per
//   round p50 1 / p90 2. Claude rounds/session p50 14 / p90 107; the source
//   study logged 140,338 Claude model steps over 2,676 sessions (~52 mean).
// - 2026 Copilot production study (arXiv:2608.00101): median 15 LLM calls and
//   13 tool calls per session, p90 100.5 LLM calls / 111 tool calls; 68K median
//   prompt TOKENS (not bytes). Used only as a cross-check on call counts,
//   never as a byte budget.
// - MCP tool-declaration audits: 1 server / 2 tools = 2,522 serialized chars
//   (Context7); 5 servers / 58 tools ~= 55K TOKENS (not bytes), server
//   distribution unknown. These scenarios therefore declare explicit tool JSON
//   and report the self-measured serialized bytes (shape.declaredToolsBytes)
//   instead of converting token anchors.
// - TraceLab has no public subagent linkage. Subagent branches here are an
//   explicit scenario assumption with client-side lineage paths: median-shaped
//   has none, mean-shaped-mcp adds root -> child-0 (depth 1), and
//   p90-shaped-nested adds root -> child-0 -> grandchild-0 (depth 2). The
//   interactions table has no cross-thread sub-agent foreign key, so each
//   branch is a separate model session/head (separate sessionId) and the
//   lineage exists only as fixture metadata reported in the JSON (a 96-trace
//   HF sample with 618 groups is anecdotal and never presented as typical).
// - Connected MCP server counts are inferred from the configured tool-name
//   namespace prefixes (e.g. "context7__*" = one server); the real connected-
//   server distribution behind public audits is unavailable.

test("claude-shaped 2026 coding-agent scenarios (anchors, not averages)", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();
  const results = [];
  for (const scenario of [
    {
      name: "median-shaped",
      branches: [{ path: "root", calls: 14 }],
      tools: MCP_TOOLSET_SMALL,
      anchor:
        "TraceLab Claude rounds/session p50 (14 model calls); no subagent branches; small 2-tool MCP declaration (1 inferred server)",
    },
    {
      name: "mean-shaped-mcp",
      branches: [
        { path: "root", calls: 52 },
        { path: "root/child-0", calls: 8 },
      ],
      tools: MCP_TOOLSET_LARGE,
      anchor:
        "TraceLab source-study Claude mean (140,338 steps / 2,676 sessions ~= 52 model calls); depth-1 subagent branch root -> child-0 (scenario assumption); 8-tool MCP declaration",
    },
    {
      name: "p90-shaped-nested",
      branches: [
        { path: "root", calls: 107 },
        { path: "root/child-0", calls: 10 },
        { path: "root/child-0/grandchild-0", calls: 10 },
      ],
      tools: MCP_TOOLSET_LARGE,
      anchor:
        "TraceLab Claude rounds/session p90 (107 model calls); depth-2 subagent lineage root -> child-0 -> grandchild-0 (scenario assumption); 8-tool MCP declaration",
    },
  ]) {
    results.push(
      await runClaudeShapedScenario({ profileId: agent.id, ...scenario }),
    );
  }

  process.stdout.write(
    `SESSION_STORAGE_BENCHMARK_JSON=${JSON.stringify({
      suite: "claude-shaped-2026",
      node: process.version,
      samplesPerCodec: 7,
      provenance: [
        "Scenario names are anchors from public sources, not claimed industry averages: median-shaped = TraceLab Claude rounds/session p50 14; mean-shaped-mcp = source-study mean ~52 (140,338 steps / 2,676 sessions); p90-shaped-nested = TraceLab p90 107.",
        "TraceLab v0.0.2 DuckDB asset SHA256 a7bab286bc640844560850965ccf47975cf66407154132abaab90f27ec9be744 (8,058 released sessions; the prior paper's 4,265 sessions are a different count). Content sizes use the sanitized full-dataset measured percentiles: tool_result p50 407 / p90 8,219 chars, user_message p50 372 / p90 8,381, assistant text p50 204, tool input p50 197, tool results per round p50 1 / p90 2.",
        "Copilot production study arXiv:2608.00101 (median 15 LLM calls / 13 tool calls, p90 100.5 / 111; 68K median prompt tokens, not bytes) corroborates call counts only.",
        "MCP tool declarations are explicit scenario JSON with self-measured serialized bytes (shape.declaredToolsBytes); public audits (Context7 1 server / 2 tools = 2,522 chars; 5 servers / 58 tools ~= 55K tokens, not bytes) do not provide a byte distribution.",
        "Subagent branches are an explicit scenario assumption with client-side lineage paths (median-shaped: none; mean-shaped-mcp: root -> child-0 at depth 1; p90-shaped-nested: root -> child-0 -> grandchild-0 at depth 2). The interactions table has no cross-thread sub-agent FK, so every branch is a separate model session/head and lineage is fixture metadata only. TraceLab has no public subagent linkage; the 96-trace HF sample (618 groups) is anecdotal.",
        "Connected MCP server counts are inferred from configured tool-name namespace prefixes (shape.connectedMcpServers / shape.mcpServerPrefixes): the 2-tool Context7 set counts as 1 server; the 8-tool set counts its exact prefixes. The real connected-server distribution behind public audits is unavailable.",
        "Cold exactness is verified on a bounded stable sample of rows per chain (coldCheckedRows) because a full cold sweep is quadratic in chain length; warm exactness is verified on every row.",
        "The at-rest caveats of the first suite apply unchanged: no compression at rest for interactions; content encryption inflates bytes; transcriptCodec is not measured in this suite.",
      ],
      results,
    })}\n`,
  );
  for (const result of results) {
    if (!result.lossless) {
      process.stderr.write(
        `INVALID LOSSLESS COMPARISON: ${result.workload} has ${result.warmMismatches} warm and ${result.coldMismatches} cold mismatches over ${result.coldCheckedRows} cold-checked rows.\n`,
      );
    }
    const encrypted = result.contentEncryption;
    if (
      !encrypted.allRowsEncrypted ||
      encrypted.warmMismatches !== result.warmMismatches ||
      encrypted.coldMismatches !== result.coldMismatches
    ) {
      process.stderr.write(
        `INVALID ENCRYPTED COMPARISON: ${result.workload} has allRowsEncrypted=${encrypted.allRowsEncrypted}, ${encrypted.warmMismatches} warm and ${encrypted.coldMismatches} cold mismatches versus ${result.warmMismatches}/${result.coldMismatches} plaintext.\n`,
      );
    }
  }
  if (results.some((result) => !result.lossless)) {
    throw new Error("A claude-shaped workload did not reconstruct exactly");
  }
  if (
    results.some(
      (result) =>
        !result.contentEncryption.allRowsEncrypted ||
        result.contentEncryption.warmMismatches !== result.warmMismatches ||
        result.contentEncryption.coldMismatches !== result.coldMismatches,
    )
  ) {
    throw new Error(
      "Encrypted rows were not all envelopes or encryption changed reconstruction behavior",
    );
  }
}, 240_000);

type ClaudeShapedRequest = { messages: unknown[]; [key: string]: unknown };

async function runClaudeShapedScenario(params: {
  profileId: string;
  name: string;
  anchor: string;
  tools: unknown[];
  branches: Array<{ path: string; calls: number }>;
}) {
  InteractionDeltaManager.reset();
  const branchPaths = new Set(params.branches.map((branch) => branch.path));
  for (const branch of params.branches) {
    const parentPath = branchParentPath(branch.path);
    if (parentPath !== null && !branchPaths.has(parentPath)) {
      throw new Error(
        `Branch ${branch.path} is missing parent branch ${parentPath}`,
      );
    }
  }
  const root = params.branches.find((branch) => branch.path === "root");
  if (!root) throw new Error("Scenario is missing its root branch");

  const writeMs: number[] = [];
  let warmMismatches = 0;
  const branchRuns: Array<{
    path: string;
    generated: ReturnType<typeof makeClaudeShapedRequests>;
    rows: Awaited<ReturnType<typeof InteractionModel.create>>[];
    plain: Buffer[];
    delta: Buffer[];
  }> = [];

  for (const [index, branch] of params.branches.entries()) {
    const generated = makeClaudeShapedRequests({
      calls: branch.calls,
      tools: params.tools,
      seed: 11 + index * 37,
    });
    // Every branch is a separate model session/head: the interactions table
    // has no cross-thread sub-agent FK, so lineage is client-side metadata.
    const sessionId = `bench-${params.name}-claude-${branch.path.replaceAll("/", "-")}`;
    const plain: Buffer[] = [];
    const delta: Buffer[] = [];
    const rows = [];
    for (const request of generated.requests) {
      const data: InsertInteraction = {
        profileId: params.profileId,
        sessionId,
        sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
        type: "anthropic:messages",
        request: request as InsertInteraction["request"],
        processedRequest: request as InsertInteraction["processedRequest"],
        response: RESPONSE as InsertInteraction["response"],
      };
      const started = process.hrtime.bigint();
      const row = await InteractionModel.create(data);
      writeMs.push(msSince(started));
      rows.push(row);

      plain.push(
        Buffer.from(JSON.stringify({ request, processedRequest: request })),
      );
      delta.push(
        Buffer.from(
          JSON.stringify({
            request: row.request,
            processedRequest: row.processedRequest,
            parentId: row.parentId,
            threadId: row.threadId,
            requestSharedPrefix: row.requestSharedPrefix,
            processedRequestSharedPrefix: row.processedRequestSharedPrefix,
            requestLastMessageIdx: row.requestLastMessageIdx,
            requestLastMessageHash: row.requestLastMessageHash,
          }),
        ),
      );
      const warm = await InteractionDeltaManager.reconstructRow(row);
      if (
        !isDeepStrictEqual(warm.request, request) ||
        !isDeepStrictEqual(warm.processedRequest, request)
      ) {
        warmMismatches++;
      }
    }
    branchRuns.push({ path: branch.path, generated, rows, plain, delta });
  }

  let coldMismatches = 0;
  let coldCheckedRows = 0;
  for (const run of branchRuns) {
    for (const index of sampleIndices(run.rows.length)) {
      InteractionDeltaManager.reset();
      const cold = await InteractionDeltaManager.reconstructRow(
        run.rows[index],
      );
      coldCheckedRows++;
      if (
        !isDeepStrictEqual(cold.request, run.generated.requests[index]) ||
        !isDeepStrictEqual(cold.processedRequest, run.generated.requests[index])
      ) {
        coldMismatches++;
      }
    }
  }

  const coldReadMs = [];
  const warmReadMs = [];
  const rootRun = branchRuns.find((run) => run.path === "root");
  const tip = rootRun?.rows.at(-1);
  if (!tip) throw new Error("Missing claude-shaped benchmark tip");
  for (let i = 0; i < 7; i++) {
    InteractionDeltaManager.reset();
    const started = process.hrtime.bigint();
    await InteractionDeltaManager.reconstructRow(tip);
    coldReadMs.push(msSince(started));
    const warmStarted = process.hrtime.bigint();
    await InteractionDeltaManager.reconstructRow(tip);
    warmReadMs.push(msSince(warmStarted));
  }

  // Encryption on/off through the real model path, per branch, so each branch
  // keeps its own (sessionId, threadId) linkage.
  const branchResults = [];
  for (const run of branchRuns) {
    const encrypted = await measureContentEncryptionAtRest({
      profileId: params.profileId,
      name: `${params.name}-claude-${run.path.replaceAll("/", "-")}`,
      requests: run.generated.requests,
      appendEvents: appendEventsOf(run.generated.requests),
    });
    branchResults.push({
      path: run.path,
      depth: branchDepth(run.path),
      parentPath: branchParentPath(run.path),
      rows: run.rows.length,
      chainedRows: run.rows.filter((row) => row.parentId !== null).length,
      finalMessages: run.generated.requests.at(-1)?.messages.length,
      finalRequestBytes: Buffer.byteLength(
        JSON.stringify(run.generated.requests.at(-1)),
      ),
      turnBytes: run.generated.budget.turnBytes,
      rawBytes: { full: sumBytes(run.plain), delta: sumBytes(run.delta) },
      encryptedBytes: {
        full: encrypted.fullBytes,
        deltaViaModel: encrypted.deltaViaModelBytes,
      },
      encrypted,
    });
  }

  const plain = branchRuns.flatMap((run) => run.plain);
  const delta = branchRuns.flatMap((run) => run.delta);
  const contentEncryption = {
    fullBytes: branchResults.reduce(
      (sum, branch) => sum + branch.encryptedBytes.full,
      0,
    ),
    deltaViaModelBytes: branchResults.reduce(
      (sum, branch) => sum + branch.encryptedBytes.deltaViaModel,
      0,
    ),
    allRowsEncrypted: branchResults.every(
      (branch) => branch.encrypted.allRowsEncrypted,
    ),
    warmMismatches: branchResults.reduce(
      (sum, branch) => sum + branch.encrypted.warmMismatches,
      0,
    ),
    coldMismatches: branchResults.reduce(
      (sum, branch) => sum + branch.encrypted.coldMismatches,
      0,
    ),
    codecMs: branchResults[0]?.encrypted.codecMs,
  };
  const serverPrefixes = mcpServerPrefixes(params.tools);
  const rootResult = branchResults.find((branch) => branch.path === "root");
  const subagentBranches = branchResults.filter(
    (branch) => branch.path !== "root",
  );

  return {
    workload: params.name,
    anchor: params.anchor,
    shape: {
      rootModelCalls: root.calls,
      subagentBranchCount: subagentBranches.length,
      maxSubagentDepth: subagentBranches.reduce(
        (max, branch) => Math.max(max, branch.depth),
        0,
      ),
      lineage: params.branches.map((branch) => ({
        path: branch.path,
        depth: branchDepth(branch.path),
        parentPath: branchParentPath(branch.path),
        calls: branch.calls,
      })),
      connectedMcpServers: serverPrefixes.length,
      mcpServerPrefixes: serverPrefixes,
      declaredToolCount: params.tools.length,
      declaredToolsBytes: rootRun?.generated.budget.declaredToolsBytes,
      systemBytes: rootRun?.generated.budget.systemBytes,
      rootFinalRequestBytes: rootResult?.finalRequestBytes,
    },
    branches: branchResults.map(({ encrypted: _, ...branch }) => branch),
    rows: branchResults.reduce((sum, branch) => sum + branch.rows, 0),
    chainedRows: branchResults.reduce(
      (sum, branch) => sum + branch.chainedRows,
      0,
    ),
    finalMessages: rootResult?.finalMessages,
    rawBytes: {
      full: sumBytes(plain),
      delta: sumBytes(delta),
    },
    encryptedBytes: {
      full: contentEncryption.fullBytes,
      deltaViaModel: contentEncryption.deltaViaModelBytes,
    },
    gzipBytes: {
      full: compressedBytes(plain, gzipSync),
      delta: compressedBytes(delta, gzipSync),
    },
    zstdBytes: {
      full: compressedBytes(plain, zstdCompressSync),
      delta: compressedBytes(delta, zstdCompressSync),
    },
    wholeSessionZstdBytes: {
      full: wholeSessionBytes(plain),
      delta: wholeSessionBytes(delta),
    },
    contentEncryption,
    medianWriteMs: median(writeMs),
    medianWarmTipReadMs: median(warmReadMs),
    medianColdTipReadMs: median(coldReadMs),
    warmMismatches,
    coldMismatches,
    coldCheckedRows,
    lossless: warmMismatches === 0 && coldMismatches === 0,
    codecMs: {
      fullGzip: codecTime(plain, gzipSync, gunzipSync),
      fullZstd: codecTime(plain, zstdCompressSync, zstdDecompressSync),
      deltaGzip: codecTime(delta, gzipSync, gunzipSync),
      deltaZstd: codecTime(delta, zstdCompressSync, zstdDecompressSync),
      contentEncryption: contentEncryption.codecMs,
    },
  };
}

/** Depth of a client-side lineage path: "root" = 0, "root/child-0" = 1. */
function branchDepth(path: string): number {
  return path.split("/").length - 1;
}

function branchParentPath(path: string): string | null {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? null : path.slice(0, separator);
}

/**
 * Inferred connected MCP servers from configured tool-name namespace prefixes
 * ("context7__resolve-library-id" -> "context7"). The real connected-server
 * distribution behind public tool-count audits is unavailable, so this is an
 * exact count over the declared fixture, not a production measurement.
 */
function mcpServerPrefixes(tools: unknown[]): string[] {
  return [
    ...new Set(
      tools.map((tool) => {
        const name = (tool as { name?: string }).name ?? "";
        const separator = name.indexOf("__");
        return separator === -1 ? name : name.slice(0, separator);
      }),
    ),
  ].sort();
}

/**
 * Deterministic Claude-shaped coding-agent session: a sizeable system prompt,
 * an explicit MCP tool declaration, then per model call an assistant message
 * (text p50 204 chars + 1-2 tool_use blocks with p50 197-char inputs) followed
 * by a user message carrying tool_result blocks (p50 407 chars, every tenth at
 * p90 8,219) per the TraceLab measured percentiles. A single p90 8,381-char
 * user message interjects at the midpoint (user_message p90 anchor). All sizes
 * are scenario anchors, not measured averages of this codebase.
 */
function makeClaudeShapedRequests(params: {
  calls: number;
  tools: unknown[];
  seed: number;
}): { requests: ClaudeShapedRequest[]; budget: ClaudeShapedBudget } {
  const { calls, tools, seed } = params;
  const messages: unknown[] = [];
  const requests: ClaudeShapedRequest[] = [];
  const system = `You are an autonomous coding agent working in a repository. ${text(2400, seed * 7 + 1)}`;
  const budget: ClaudeShapedBudget = {
    systemBytes: Buffer.byteLength(system),
    declaredToolsBytes: Buffer.byteLength(JSON.stringify(tools)),
    turnBytes: {
      userTextBytes: 0,
      assistantTextBytes: 0,
      toolUseInputBytes: 0,
      toolResultBytes: 0,
      toolResultCount: 0,
      p90ToolResultCount: 0,
      toolCallsPerRound: { one: 0, two: 0 },
    },
  };
  const toolName =
    (tools[0] as { name?: string } | undefined)?.name ?? "read_file";

  for (let call = 0; call < calls; call++) {
    if (call === 0) {
      const userText = text(372, seed + 3);
      budget.turnBytes.userTextBytes += Buffer.byteLength(userText);
      messages.push({ role: "user", content: userText });
    } else {
      // Tool results per round: p50 1 / p90 2 - every ninth round runs two.
      const toolUseCount = call % 9 === 4 ? 2 : 1;
      budget.turnBytes.toolCallsPerRound[toolUseCount === 2 ? "two" : "one"]++;
      const assistantText = text(204, seed + call * 13 + 5);
      budget.turnBytes.assistantTextBytes += Buffer.byteLength(assistantText);
      const assistantContent: unknown[] = [
        { type: "text", text: assistantText },
      ];
      const resultContent: unknown[] = [];
      for (let k = 0; k < toolUseCount; k++) {
        const input = {
          path: `src/module-${call}-${k}.ts`,
          note: text(197, seed + call * 17 + k),
        };
        budget.turnBytes.toolUseInputBytes += Buffer.byteLength(
          JSON.stringify(input),
        );
        assistantContent.push({
          type: "tool_use",
          id: `toolu_${call}_${k}`,
          name: toolName,
          input,
        });
        const p90 = (call + k) % 10 === 5;
        const resultText = text(p90 ? 8219 : 407, seed + call * 19 + k);
        budget.turnBytes.toolResultBytes += Buffer.byteLength(resultText);
        budget.turnBytes.toolResultCount++;
        if (p90) budget.turnBytes.p90ToolResultCount++;
        resultContent.push({
          type: "tool_result",
          tool_use_id: `toolu_${call}_${k}`,
          content: resultText,
        });
      }
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({ role: "user", content: resultContent });
    }
    if (call === Math.floor(calls / 2)) {
      const interjection = text(8381, seed + 997);
      budget.turnBytes.userTextBytes += Buffer.byteLength(interjection);
      messages.push({ role: "user", content: interjection });
    }
    requests.push({
      model: "claude-sonnet",
      max_tokens: 4096,
      system,
      tools,
      messages: [...messages],
    });
  }
  return { requests, budget };
}

type ClaudeShapedBudget = {
  systemBytes: number;
  declaredToolsBytes: number;
  turnBytes: {
    userTextBytes: number;
    assistantTextBytes: number;
    toolUseInputBytes: number;
    toolResultBytes: number;
    toolResultCount: number;
    p90ToolResultCount: number;
    toolCallsPerRound: { one: number; two: number };
  };
};

function appendEventsOf(requests: ClaudeShapedRequest[]) {
  return requests.map((request, index) => {
    const previousLength = requests[index - 1]?.messages.length ?? 0;
    return index === 0
      ? { request, processedRequest: request }
      : {
          request: { messages: request.messages.slice(previousLength) },
          processedRequest: {
            messages: request.messages.slice(previousLength),
          },
        };
  });
}

/** Bounded evenly-spaced stable sample for cold-cache exactness checks. */
function sampleIndices(length: number): number[] {
  return [
    ...new Set(
      [
        0,
        1,
        Math.floor(length / 4),
        Math.floor(length / 2),
        Math.floor((3 * length) / 4),
        length - 2,
        length - 1,
      ].filter((index) => index >= 0 && index < length),
    ),
  ].sort((a, b) => a - b);
}

// Explicit MCP tool declarations. Serialized bytes are self-measured into
// shape.declaredToolsBytes; the public anchors (Context7 1 server / 2 tools =
// 2,522 chars; 5 servers / 58 tools ~= 55K tokens, not bytes) only bound the
// plausible range and are not used as byte budgets.
const MCP_TOOLSET_SMALL: unknown[] = [
  {
    name: "context7__resolve-library-id",
    description:
      "Resolves a package name or product name to a Context7-compatible library ID and returns a ranked list of matching libraries. Call this before fetching documentation whenever the user's question names a library, framework, or SDK, unless an exact library ID was already supplied. Returns each candidate's ID, name, description, code-snippet count, and trust score so the caller can disambiguate.",
    inputSchema: {
      type: "object",
      properties: {
        libraryName: {
          type: "string",
          description:
            "Library name to search for and resolve, e.g. 'react', 'next.js', or 'drizzle'.",
        },
        query: {
          type: "string",
          description:
            "The user's original question, used to rank candidates by relevance.",
        },
      },
      required: ["libraryName", "query"],
    },
  },
  {
    name: "context7__get-library-docs",
    description:
      "Fetches up-to-date documentation and code examples for a Context7-compatible library ID. Use the exact ID returned by resolve-library-id (format '/org/project' or '/org/project/version'). Results are trimmed to the requested topic when one is provided.",
    inputSchema: {
      type: "object",
      properties: {
        context7CompatibleLibraryID: {
          type: "string",
          description:
            "Exact Context7-compatible library ID, e.g. '/facebook/react'.",
        },
        topic: {
          type: "string",
          description:
            "Topic to focus documentation on, e.g. 'hooks', 'routing', 'migrations'.",
        },
        tokens: {
          type: "number",
          description:
            "Maximum number of tokens of documentation to retrieve (default 5000).",
        },
      },
      required: ["context7CompatibleLibraryID"],
    },
  },
];

const MCP_TOOLSET_LARGE: unknown[] = [
  ...MCP_TOOLSET_SMALL,
  {
    name: "filesystem__read_file",
    description:
      "Reads the complete contents of a file from the workspace as UTF-8 text. Paths are resolved relative to the workspace root; absolute paths outside the workspace are rejected. Large files are truncated at 1 MiB unless an offset and length window is given.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        offset: {
          type: "number",
          description: "Byte offset to start reading from (default 0).",
        },
        length: {
          type: "number",
          description: "Maximum number of bytes to read.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "filesystem__write_file",
    description:
      "Writes UTF-8 content to a workspace file, creating parent directories as needed. Fails if the file exists and overwrite is false. Returns the number of bytes written.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "Full file content to write." },
        overwrite: {
          type: "boolean",
          description: "Replace an existing file (default false).",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "filesystem__search",
    description:
      "Searches file contents under a workspace directory using a regular expression, returning matching lines with file paths and line numbers. Honors .gitignore by default; set includeIgnored to search ignored files too.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          description: "Workspace-relative directory to search under.",
        },
        pattern: {
          type: "string",
          description: "Regular expression matched against each line.",
        },
        glob: {
          type: "string",
          description: "Optional glob restricting searched files, e.g. '*.ts'.",
        },
        includeIgnored: {
          type: "boolean",
          description: "Also search gitignored files (default false).",
        },
        maxResults: {
          type: "number",
          description: "Maximum matching lines to return (default 200).",
        },
      },
      required: ["root", "pattern"],
    },
  },
  {
    name: "shell__run_command",
    description:
      "Runs a shell command in the workspace with a configurable timeout and returns stdout, stderr, and the exit code. Commands run without network access by default; set network to true only for package installs or fetches the user asked for.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: {
          type: "string",
          description: "Working directory, workspace-relative (default root).",
        },
        timeoutSeconds: {
          type: "number",
          description: "Wall-clock timeout in seconds (default 120).",
        },
        network: {
          type: "boolean",
          description: "Allow outbound network access (default false).",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "git__diff",
    description:
      "Returns the unified diff of the working tree or between two refs. Paths restrict the diff to matching files. The result is truncated at 256 KiB; use paths to narrow large diffs.",
    inputSchema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          description: "Base ref (default: working tree versus HEAD).",
        },
        head: { type: "string", description: "Head ref (default HEAD)." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional path filters.",
        },
      },
    },
  },
  {
    name: "fetch__get",
    description:
      "Fetches a URL over HTTPS and returns the response body as text, converting HTML to markdown when possible. Only http and https schemes are allowed; redirects are followed up to 5 times. The body is truncated at 512 KiB.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Fully-formed URL to fetch." },
        raw: {
          type: "boolean",
          description: "Return the raw body without markdown conversion.",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters to return.",
        },
      },
      required: ["url"],
    },
  },
];

function makeRequests(
  turns: number,
  movingBreakpoint?: boolean,
  editedHistory?: boolean,
) {
  const messages: unknown[] = [];
  const requests: Array<{ messages: unknown[]; [key: string]: unknown }> = [];
  const system = `You review a small code project. ${text(600, 99)}`;
  const tools = [
    {
      name: "read_file",
      description: text(900, 101),
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
    {
      name: "search",
      description: text(900, 102),
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ];
  for (let turn = 0; turn < turns; turn++) {
    if (turn > 0) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: text(360, turn + 200) }],
      });
    }
    messages.push({ role: "user", content: text(700, turn) });
    const current = [...messages];
    if (movingBreakpoint) {
      current[current.length - 1] = {
        role: "user",
        content: [
          {
            type: "text",
            text: text(700, turn),
            cache_control: { type: "ephemeral" },
          },
        ],
      };
    }
    if (editedHistory && turn >= 3) {
      current[2] = { role: "user", content: "[earlier message shortened]" };
    }
    requests.push({
      model: "claude-sonnet",
      max_tokens: 1024,
      system,
      tools,
      messages: current,
    });
  }
  return requests;
}

function text(length: number, seed: number): string {
  const chunks: string[] = [];
  for (let i = 0; chunks.join("").length < length; i++) {
    chunks.push(
      `inspect the file and explain line ${i}: ${createHash("sha256").update(`${seed}:${i}`).digest("hex")} `,
    );
  }
  return chunks.join("").slice(0, length);
}

function sumBytes(buffers: Buffer[]): number {
  return buffers.reduce((sum, buffer) => sum + buffer.length, 0);
}

function compressedBytes(
  buffers: Buffer[],
  compress: (buffer: Buffer) => Buffer,
): number {
  return buffers.reduce((sum, buffer) => sum + compress(buffer).length, 0);
}

function wholeSessionBytes(buffers: Buffer[]): number {
  const session = Buffer.concat(
    buffers.flatMap((buffer) => [buffer, Buffer.from("\n")]),
  );
  const compressed = zstdCompressSync(session);
  if (!zstdDecompressSync(compressed).equals(session)) {
    throw new Error("Whole-session compression failed to restore the log");
  }
  return compressed.length;
}

function codecTime(
  buffers: Buffer[],
  compress: (buffer: Buffer) => Buffer,
  decompress: (buffer: Buffer) => Buffer,
) {
  const writeMs = [];
  const readMs = [];
  for (let repeat = 0; repeat < 7; repeat++) {
    const started = process.hrtime.bigint();
    const encoded = buffers.map(compress);
    writeMs.push(msSince(started));
    const readStarted = process.hrtime.bigint();
    for (let i = 0; i < buffers.length; i++) {
      if (!decompress(encoded[i]).equals(buffers[i])) {
        throw new Error("Compression failed to restore the request");
      }
    }
    readMs.push(msSince(readStarted));
  }
  return { medianEncodeMs: median(writeMs), medianDecodeMs: median(readMs) };
}

/**
 * Real on/off comparison for the platform's at-rest feature on interaction
 * payloads: enterprise AES-256-GCM content encryption. Runs the same workload
 * through InteractionModel.create with encryption enabled (delta encoding stays
 * active) and counts the actual stored bytes read back from the database.
 */
async function measureContentEncryptionAtRest(params: {
  profileId: string;
  name: string;
  requests: ReturnType<typeof makeRequests>;
  appendEvents: Array<{ request: unknown; processedRequest: unknown }>;
}) {
  const previousSecret = config.contentEncryption.secret;
  const previousCore = config.enterpriseFeatures.core;
  config.enterpriseFeatures.core = true;
  config.contentEncryption.secret = "bench-content-secret-0123456789abcdef";
  _resetContentKeys();
  InteractionDeltaManager.reset();
  try {
    // Exact-codec sizing on matched input for the two strategies the model
    // path does not produce. Each column is wrapped as {"v": value} and sealed
    // into a `v1:` base64url envelope - see content-encryption/index.ee.ts.
    let fullBytes = 0;
    let appendOnlyBytes = 0;
    for (const [index, request] of params.requests.entries()) {
      fullBytes +=
        encryptedColumnBytes(request, "interactions.request") +
        encryptedColumnBytes(request, "interactions.processed_request");
      const event = params.appendEvents[index];
      appendOnlyBytes +=
        encryptedColumnBytes(event.request, "interactions.request") +
        encryptedColumnBytes(
          event.processedRequest,
          "interactions.processed_request",
        );
    }

    const rows = [];
    const writeMs = [];
    let deltaViaModelBytes = 0;
    let envelopesSeen = 0;
    for (const request of params.requests) {
      const data: InsertInteraction = {
        profileId: params.profileId,
        sessionId: `bench-${params.name}-enc`,
        sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
        type: "anthropic:messages",
        request: request as InsertInteraction["request"],
        processedRequest: request as InsertInteraction["processedRequest"],
        response: RESPONSE as InsertInteraction["response"],
      };
      const started = process.hrtime.bigint();
      const row = await InteractionModel.create(data);
      writeMs.push(msSince(started));
      rows.push(row);

      // create() returns the decrypted row; read the raw row back to count the
      // bytes actually stored: per-column ciphertext envelopes plus the delta
      // navigation metadata, which stays plaintext under content encryption.
      // Raw SQL via the PGlite client: drizzle-orm is not resolvable from this
      // directory under pnpm's isolated installs.
      const { rows: rawRows } = await db.$client.query<{
        request: unknown;
        processed_request: unknown;
        parent_id: string | null;
        thread_id: string | null;
        request_shared_prefix: number | null;
        processed_request_shared_prefix: number | null;
        request_last_message_idx: number | null;
        request_last_message_hash: string | null;
      }>(
        `SELECT request, processed_request, parent_id, thread_id,
                request_shared_prefix, processed_request_shared_prefix,
                request_last_message_idx, request_last_message_hash
         FROM interactions WHERE id = $1`,
        [row.id],
      );
      const raw = rawRows[0];
      if (!raw) throw new Error("Missing stored benchmark row");
      if (isContentEnvelope(raw.request)) envelopesSeen++;
      if (isContentEnvelope(raw.processed_request)) envelopesSeen++;
      deltaViaModelBytes +=
        JSON.stringify(raw.request).length +
        JSON.stringify(raw.processed_request).length +
        JSON.stringify({
          parentId: raw.parent_id,
          threadId: raw.thread_id,
          requestSharedPrefix: raw.request_shared_prefix,
          processedRequestSharedPrefix: raw.processed_request_shared_prefix,
          requestLastMessageIdx: raw.request_last_message_idx,
          requestLastMessageHash: raw.request_last_message_hash,
        }).length;
    }

    let warmMismatches = 0;
    for (const [index, row] of rows.entries()) {
      const warm = await InteractionDeltaManager.reconstructRow(row);
      if (
        !isDeepStrictEqual(warm.request, params.requests[index]) ||
        !isDeepStrictEqual(warm.processedRequest, params.requests[index])
      ) {
        warmMismatches++;
      }
    }
    let coldMismatches = 0;
    for (const [index, row] of rows.entries()) {
      InteractionDeltaManager.reset();
      const cold = await InteractionDeltaManager.reconstructRow(row);
      if (
        !isDeepStrictEqual(cold.request, params.requests[index]) ||
        !isDeepStrictEqual(cold.processedRequest, params.requests[index])
      ) {
        coldMismatches++;
      }
    }

    const coldReadMs = [];
    const warmReadMs = [];
    const tip = rows.at(-1);
    if (!tip) throw new Error("Missing encrypted benchmark tip");
    for (let i = 0; i < 7; i++) {
      InteractionDeltaManager.reset();
      const started = process.hrtime.bigint();
      await InteractionDeltaManager.reconstructRow(tip);
      coldReadMs.push(msSince(started));
      const warmStarted = process.hrtime.bigint();
      await InteractionDeltaManager.reconstructRow(tip);
      warmReadMs.push(msSince(warmStarted));
    }

    return {
      fullBytes,
      appendOnlyBytes,
      deltaViaModelBytes,
      allRowsEncrypted: envelopesSeen === rows.length * 2,
      medianWriteMs: median(writeMs),
      medianWarmTipReadMs: median(warmReadMs),
      medianColdTipReadMs: median(coldReadMs),
      warmMismatches,
      coldMismatches,
      codecMs: contentEncryptionCodecTime(params.requests),
    };
  } finally {
    config.contentEncryption.secret = previousSecret;
    config.enterpriseFeatures.core = previousCore;
    _resetContentKeys();
    InteractionDeltaManager.reset();
  }
}

/**
 * Stored byte size of one column under the exact at-rest codec:
 * encryptContentValue's `{ __encrypted: "v1:..." }` envelope as persisted into
 * the jsonb column.
 */
function encryptedColumnBytes(
  value: unknown,
  context: "interactions.request" | "interactions.processed_request",
): number {
  return JSON.stringify(encryptContentValue(value, context)).length;
}

/**
 * The platform's production compression-at-rest codec, replicated exactly from
 * backend/src/services/agent-runtime/transcript-store.ts: the session log is
 * split into 256 KiB raw chunks and each chunk is gzipped with node:zlib
 * defaults (the async `gzip` there and `gzipSync` here share zlib defaults).
 */
function transcriptCodecBytes(buffers: Buffer[]): number {
  const session = Buffer.concat(
    buffers.flatMap((buffer) => [buffer, Buffer.from("\n")]),
  );
  let total = 0;
  for (
    let offset = 0;
    offset < session.length;
    offset += TRANSCRIPT_RAW_CHUNK_BYTES
  ) {
    const chunk = session.subarray(offset, offset + TRANSCRIPT_RAW_CHUNK_BYTES);
    const compressed = gzipSync(chunk);
    if (!gunzipSync(compressed).equals(chunk)) {
      throw new Error("Transcript-codec compression failed to restore a chunk");
    }
    total += compressed.length;
  }
  return total;
}

function transcriptCodecTime(buffers: Buffer[]) {
  const writeMs = [];
  const readMs = [];
  const session = Buffer.concat(
    buffers.flatMap((buffer) => [buffer, Buffer.from("\n")]),
  );
  const chunks: Buffer[] = [];
  for (
    let offset = 0;
    offset < session.length;
    offset += TRANSCRIPT_RAW_CHUNK_BYTES
  ) {
    chunks.push(session.subarray(offset, offset + TRANSCRIPT_RAW_CHUNK_BYTES));
  }
  for (let repeat = 0; repeat < 7; repeat++) {
    const started = process.hrtime.bigint();
    const encoded = chunks.map((chunk) => gzipSync(chunk));
    writeMs.push(msSince(started));
    const readStarted = process.hrtime.bigint();
    for (let i = 0; i < chunks.length; i++) {
      if (!gunzipSync(encoded[i]).equals(chunks[i])) {
        throw new Error(
          "Transcript-codec compression failed to restore a chunk",
        );
      }
    }
    readMs.push(msSince(readStarted));
  }
  return { medianEncodeMs: median(writeMs), medianDecodeMs: median(readMs) };
}

/** Round-trip timing for the content-encryption codec on matched input. */
function contentEncryptionCodecTime(requests: ReturnType<typeof makeRequests>) {
  const writeMs = [];
  const readMs = [];
  for (let repeat = 0; repeat < 7; repeat++) {
    const started = process.hrtime.bigint();
    const encoded = requests.map((request) => ({
      request: encryptContentValue(request, "interactions.request"),
      processedRequest: encryptContentValue(
        request,
        "interactions.processed_request",
      ),
    }));
    writeMs.push(msSince(started));
    const readStarted = process.hrtime.bigint();
    for (let i = 0; i < requests.length; i++) {
      if (
        !isDeepStrictEqual(
          decryptContentValue(encoded[i].request, "interactions.request"),
          requests[i],
        ) ||
        !isDeepStrictEqual(
          decryptContentValue(
            encoded[i].processedRequest,
            "interactions.processed_request",
          ),
          requests[i],
        )
      ) {
        throw new Error("Content encryption failed to restore the request");
      }
    }
    readMs.push(msSince(readStarted));
  }
  return { medianEncodeMs: median(writeMs), medianDecodeMs: median(readMs) };
}

const TRANSCRIPT_RAW_CHUNK_BYTES = 256 * 1024;

function msSince(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
