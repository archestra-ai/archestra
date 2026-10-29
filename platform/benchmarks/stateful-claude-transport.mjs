import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runNativeClaude } from "./claude-parity-ab.mjs";
import { normalizeUsage, verifyCapture } from "./live-ab.mjs";
import { buildClientLaunch } from "./native-client.mjs";
import { createRemedyWitnessSession } from "./remedy-witness-session.mjs";
import { projectRemedyHistory } from "./stateful-remedy-evidence.mjs";

export async function createStatefulClaudeTransport({
  proxyBase,
  captureBase,
  agent,
  gatewayToken,
  passthroughKey,
  tools,
  namespace,
  env = process.env,
  runNative = runNativeClaude,
  timeoutMs = 120000,
  privateEvidence,
}) {
  for (const value of [proxyBase, captureBase]) {
    const url = new URL(value);
    assert.ok(
      url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
      "Loopback origins required.",
    );
  }
  assert.ok(
    typeof agent === "string" && /^[a-z0-9-]+$/i.exec(agent)?.[0] === agent,
    "Invalid transport agent ID.",
  );
  assert.match(namespace, /^[a-f0-9-]{1,128}$/i);
  assert.ok(gatewayToken && passthroughKey && Array.isArray(tools));
  assert.ok(timeoutMs > 0 && timeoutMs <= 120000);
  const declarations = structuredClone(tools).map((tool) => {
    if (Object.hasOwn(tool, "input_schema")) {
      assert.ok(
        tool.input_schema &&
          typeof tool.input_schema === "object" &&
          !Array.isArray(tool.input_schema),
        "A frozen provider tool schema is required.",
      );
      return tool;
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  });
  for (const tool of declarations) delete tool.cache_control;
  if (declarations.length)
    declarations.at(-1).cache_control = { type: "ephemeral" };
  const jobs = new Map();
  const episodes = new Map();
  const nativePrefixes = new Map();
  const wirePrefixes = new Map();
  const active = new Set();
  const directory = await mkdtemp(join(tmpdir(), "appa-stateful-claude-"));
  const privateSession = privateEvidence
    ? await createRemedyWitnessSession({
        ...privateEvidence,
        family: "anthropic:messages",
      })
    : null;
  let closed = false;
  let closing;
  let lastEvidenceIndex = 0;
  const server = createServer(async (req, res) => {
    const job = jobs.get(req.headers["x-appa-session-id"]);
    const path = new URL(req.url, "http://127.0.0.1");
    if (
      !job ||
      job.started ||
      req.method !== "POST" ||
      path.pathname !== `/v1/anthropic/${agent}/v1/messages` ||
      (path.search && path.search !== "?beta=true")
    ) {
      if (job && path.pathname.endsWith("/messages")) job.additionalCalls++;
      req.resume();
      res.writeHead(409, { "content-type": "application/json" });
      res.end('{"error":{"type":"benchmark_request_refused"}}');
      return;
    }
    job.started = true;
    const abortRequest = () => req.destroy();
    job.signal.addEventListener("abort", abortRequest, { once: true });
    try {
      const native = JSON.parse(await boundedText(req));
      assert.ok(
        typeof native.model === "string" &&
          native.model.startsWith("claude-") &&
          Array.isArray(native.system) &&
          native.system.some((block) => /Claude Code/.test(block.text ?? "")),
        "Genuine Claude Code context required.",
      );
      const system = structuredClone(native.system);
      for (const block of system) delete block.cache_control;
      system.push({
        type: "text",
        text: `Benchmark namespace: ${namespace}.\n${job.systemText}`,
        cache_control: { type: "ephemeral" },
      });
      const messages = structuredClone(job.history);
      for (const message of messages)
        if (Array.isArray(message.content))
          for (const block of message.content) delete block.cache_control;
      if (job.cacheMode === "rolling") {
        const last = messages.at(-1);
        if (typeof last.content === "string")
          last.content = [{ type: "text", text: last.content }];
        const block = last.content.findLast((item) =>
          ["text", "tool_use", "tool_result"].includes(item.type),
        );
        assert.ok(block, "No cacheable final history block.");
        block.cache_control = { type: "ephemeral" };
      }
      // Retain all native auth-compatible body options, model limits and metadata.
      const body = {
        ...native,
        system,
        tools: declarations,
        messages,
        stream: true,
      };
      delete body.tool_choice;
      if (job.toolChoice !== undefined) body.tool_choice = job.toolChoice;
      const serialized = JSON.stringify(body);
      assert.ok(Buffer.byteLength(serialized) <= MAX_BYTES);
      const nativePrefix = {
        systemHash: digest(native.system),
        metadataHash: digest(native.metadata ?? null),
        systemBlockHashes: native.system.map(digest),
      };
      const previousNative = nativePrefixes.get(job.session);
      const nativePrefixChanges = {
        systemChanged: previousNative
          ? previousNative.systemHash !== nativePrefix.systemHash
          : null,
        metadataChanged: previousNative
          ? previousNative.metadataHash !== nativePrefix.metadataHash
          : null,
        previousSystemHash: previousNative?.systemHash ?? null,
        ...nativePrefix,
      };
      const nativeSettings = {
        thinkingType: ["adaptive", "enabled", "disabled"].includes(
          native.thinking?.type,
        )
          ? native.thinking.type
          : null,
        thinkingBudgetTokens: finite(native.thinking?.budget_tokens),
        outputEffort: ["low", "medium", "high", "max"].includes(
          native.output_config?.effort,
        )
          ? native.output_config.effort
          : null,
        maxTokens: finite(native.max_tokens),
        toolChoiceType: ["auto", "any", "tool", "none"].includes(
          body.tool_choice?.type,
        )
          ? body.tool_choice.type
          : null,
      };
      nativePrefixes.set(job.session, nativePrefix);
      const markers = [
        ...system,
        ...declarations,
        ...messages.flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        ),
      ].filter((block) => block.cache_control).length;
      assert.ok(markers <= 4);
      await privateSession?.recordClientRequest({ body });
      const start = performance.now();
      const startUnixMs = performance.timeOrigin + start;
      const response = await fetch(
        `${proxyBase.replace(/\/$/, "")}${path.pathname}${path.search}`,
        {
          method: "POST",
          redirect: "error",
          signal: job.signal,
          headers: forwardHeaders(req.headers),
          body: serialized,
        },
      );
      res.writeHead(
        response.status,
        forwardHeaders(Object.fromEntries(response.headers)),
      );
      assert.ok(response.body);
      const [client, measurement] = response.body.tee();
      // Start both consumers before awaiting either: native must see real SSE now.
      const forwarding = (async () => {
        for await (const part of client) {
          if (!res.write(part))
            await once(res, "drain", { signal: job.signal });
        }
        res.end();
      })();
      const decoding = response.ok
        ? decodeMessage(measurement, start)
        : decodeProviderError(measurement, response.status);
      const [, decoded] = await Promise.all([forwarding, decoding]);
      const latencyMs = performance.now() - start;
      await privateSession?.recordProxyResponse({
        clientBody: body,
        proxyOutput: decoded.message?.content ?? [],
      });
      let evidence = { missing: true, modeLive: false };
      try {
        // Relay persistence may finish just after the last SSE byte reaches us.
        for (let attempt = 0; attempt < 10; attempt++) {
          const capture = await fetch(
            `${captureBase.replace(/\/$/, "")}/evidence?sessionId=${encodeURIComponent(namespace)}&after=${job.evidenceAfter}`,
            {
              redirect: "error",
              signal: AbortSignal.any([job.signal, AbortSignal.timeout(10000)]),
            },
          );
          assert.ok(capture.ok);
          const captured = JSON.parse(await boundedText(capture.body));
          const record = (captured.records ?? []).findLast(
            (item) =>
              item.idx > job.evidenceAfter &&
              item.body &&
              // The unique session and incremental cursor provide ordering;
              // wall clocks can slew relative to performance.timeOrigin.
              item.status === response.status,
          );
          if (record) {
            lastEvidenceIndex = Math.max(lastEvidenceIndex, record.idx);
            let privateContext;
            let projection;
            let comparison = {
              expected: body,
              actual: record.body,
              supported: true,
              reason: null,
            };
            if (privateSession) {
              await privateSession.recordModelRoundtrip({
                clientBody: body,
                providerRecord: record,
                proxyOutput: decoded.message?.content ?? [],
                decodeOriginalResponse: async (bytes) => {
                  const original = await decodeMessage([bytes], 0);
                  return {
                    complete: original.complete,
                    output: original.message?.content ?? [],
                  };
                },
              });
              privateContext = await privateSession.resolve({
                clientBody: body,
              });
              projection = projectRemedyHistory({
                body,
                family: "anthropic:messages",
                arm: job.arm,
                client: "claude-code",
                evidence: privateContext.evidence,
              });
              comparison = privateClaudeComparison(
                body,
                record.body,
                projection,
              );
            }
            const normalized = normalizeAllowedHistory(
              comparison.expected,
              comparison.actual,
            );
            const verified = verifyCapture(
              normalized.body,
              comparison.actual,
              job.arm,
            );
            const normalizationSupported = privateSession
              ? privateContext.supported &&
                projection.supported &&
                comparison.supported &&
                normalized.report.unsupported.every((kind) =>
                  ["notice_history", "remedy_history"].includes(kind),
                )
              : normalized.report.supported;
            const wire = describeWirePrefix(
              record,
              wirePrefixes.get(job.session),
            );
            wirePrefixes.set(job.session, wire.state);
            evidence = {
              ...verified,
              ...(privateContext
                ? {
                    supported:
                      normalizationSupported && verified.semanticRetained,
                    inconclusive:
                      !normalizationSupported || !verified.semanticRetained,
                    reason: !privateContext.supported
                      ? privateContext.diagnostic.reason
                      : !projection.supported
                        ? projection.reason
                        : !comparison.supported
                          ? comparison.reason
                          : !verified.semanticRetained
                            ? "provider_capture_equality_mismatch"
                            : null,
                  }
                : {}),
              semanticRetained:
                verified.semanticRetained && normalizationSupported,
              rewriteProven: verified.rewriteProven && normalizationSupported,
              offClean: verified.offClean && normalizationSupported,
              normalization: {
                ...normalized.report,
                supported: normalizationSupported,
                unsupported: normalizationSupported
                  ? []
                  : normalized.report.unsupported,
                resolvedByPrivateRemedyProjection:
                  normalizationSupported && privateSession
                    ? normalized.report.unsupported
                    : [],
              },
              ...(privateContext
                ? {
                    privateRemedyEvidence: privateContext.diagnostic,
                    remedyProjection: {
                      supported: normalizationSupported,
                      reason: projection.supported
                        ? comparison.reason
                        : projection.reason,
                      normalizations: projection.normalizations,
                      diagnostics: projection.diagnostics,
                      sourceCitations: projection.sourceCitations,
                    },
                  }
                : {}),
              ...(job.nativeSessionHash
                ? { nativeSessionHash: job.nativeSessionHash }
                : {}),
              messagesDifference: firstMessageDifference(
                normalized.body.messages,
                comparison.actual.messages,
              ),
              nativePrefixChanges,
              sourceCacheMarkers: cacheMarkerOwners(body),
              wire: wire.report,
              mode: captured.mode,
              modeLive: captured.mode === "live",
              missing: false,
              idx: record.idx,
              requestHash: digest(record.body),
              nativeSystemHash: digest(native.system),
              sourceToolsHash: digest(declarations),
              sourceHistoryHash: digest(messages),
              arrivedUnixMs: finite(record.arrivedUnixMs),
              timingsMs: numeric(record.timingsMs),
            };
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch {
        // Missing capture must remain explicit, never turn into claimed live proof.
      }
      job.resolve({
        ok: response.ok && decoded.complete,
        status: response.status,
        providerErrorType: decoded.providerErrorType ?? null,
        providerErrorCategory: decoded.providerErrorCategory ?? null,
        providerErrorMessageHash: decoded.providerErrorMessageHash ?? null,
        error: !response.ok
          ? "provider_http_error"
          : decoded.complete
            ? null
            : "incomplete_provider_message",
        usage: normalizeUsage("anthropic", decoded.message?.usage),
        rawUsage: numeric(decoded.message?.usage),
        latencyMs,
        ttftMs: decoded.ttftMs,
        startUnixMs,
        evidence,
        message: decoded.message,
        content: decoded.message?.content ?? [],
        stopReason: decoded.message?.stop_reason ?? null,
        model: decoded.message?.model ?? body.model,
        nativeSystemHash: digest(native.system),
        nativePrefixChanges,
        nativeSettings,
        controlledToolCount: declarations.length,
        originalNativeToolCount: native.tools?.length ?? 0,
        transportLane: "genuine-claude-code-stateful-controlled-ingress",
      });
    } catch {
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "application/json" });
      if (!res.writableEnded)
        res.end('{"error":{"type":"benchmark_transport_error"}}');
      job.resolve(failed("native_ingress_failed"));
    } finally {
      job.signal.removeEventListener("abort", abortRequest);
    }
  });
  server.requestTimeout = timeoutMs;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    // Native performs no tools: the parent owns actual gateway tools/call execution.
    await writeFile(join(directory, "mcp.json"), '{"mcpServers":{}}', {
      mode: 0o600,
    });
  } catch (error) {
    server.close();
    await privateSession?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const interrupt = () => {
    void close();
  };
  for (const signal of SIGNALS) process.on(signal, interrupt);

  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      for (const job of jobs.values()) job.controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...active]);
      await privateSession?.close();
      await rm(directory, { recursive: true, force: true });
      nativePrefixes.clear();
      wirePrefixes.clear();
      for (const signal of SIGNALS) process.removeListener(signal, interrupt);
    })();
    return closing;
  }

  return {
    observeGatewayRoundtrip: async (event) =>
      privateSession
        ? privateSession.observeGatewayRoundtrip(event)
        : { supported: false, reason: "private_evidence_disabled" },
    modelStep(options) {
      const pending = step(options);
      active.add(pending);
      pending.then(
        () => active.delete(pending),
        () => active.delete(pending),
      );
      return pending;
    },
    close,
  };

  async function step({
    session,
    nativeSession,
    arm,
    history,
    systemText,
    cacheMode,
    toolChoice,
  }) {
    assert.ok(!closed, "Transport closed.");
    assert.ok(
      typeof session === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.exec(session)?.[0] === session,
      "Invalid scoped session ID.",
    );
    if (nativeSession !== undefined)
      assert.ok(
        typeof nativeSession === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(
            nativeSession,
          )?.[0] === nativeSession,
        "Explicit native session must be a UUID.",
      );
    const cliSession = nativeSession === undefined ? session : nativeSession;
    assert.ok(!jobs.has(session), "Overlapping session steps refused.");
    assert.ok(["on", "off"].includes(arm));
    assert.ok(["rolling", "system-only"].includes(cacheMode));
    assert.ok(
      Array.isArray(history) &&
        history.length &&
        typeof systemText === "string",
    );
    const stable = digest({
      arm,
      systemText,
      cacheMode,
      nativeSession: cliSession,
    });
    assert.ok(
      !episodes.has(session) || episodes.get(session) === stable,
      "Episode prefix changed.",
    );
    episodes.set(session, stable);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resolve;
    const done = new Promise((r) => {
      resolve = r;
    });
    const job = {
      started: false,
      additionalCalls: 0,
      resolve,
      controller,
      signal: controller.signal,
      session,
      nativeSessionHash:
        nativeSession === undefined ? null : digest(cliSession),
      history: structuredClone(history),
      systemText,
      arm,
      cacheMode,
      toolChoice: structuredClone(toolChoice),
      evidenceAfter: lastEvidenceIndex,
    };
    jobs.set(session, job);
    const aborted = () => resolve(failed("native_step_aborted"));
    controller.signal.addEventListener("abort", aborted, { once: true });
    let native;
    try {
      const launch = buildClientLaunch({
        client: "claude",
        base: `http://127.0.0.1:${server.address().port}`,
        agent,
        session,
        gatewayToken,
        passthroughKey,
        env,
        mcpConfig: join(directory, "mcp.json"),
        args: [
          "--print",
          "--model",
          env.ARCHESTRA_BENCHMARK_CLAUDE_MODEL ?? "sonnet",
          "--tools",
          "",
          "--session-id",
          cliSession,
          "--no-session-persistence",
          "--max-turns",
          "1",
          "--output-format",
          "json",
          "Continue the supplied benchmark conversation.",
        ],
      });
      const running = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return runNative(launch, { signal: controller.signal, timeoutMs });
        })
        .then(
          (value) => {
            native = safeNative(value);
            if (!job.started)
              resolve(failed(native.error ?? "native_no_messages_request"));
          },
          () => {
            native = { ok: false, error: "native_client_failed" };
            if (!job.started) resolve(failed("native_client_failed"));
          },
        );
      const result = await done;
      // A complete measured model message is valid even if CLI cannot execute its tools.
      if (!result.ok) controller.abort();
      await running;
      if (job.additionalCalls) {
        result.ok = false;
        result.error = "additional_native_model_calls";
      }
      // Routing syntax is not delegation proof: caller/server must validate the
      // actual signed spawn marker. Native metadata is never synthesized here.
      return {
        ...result,
        ...(job.nativeSessionHash
          ? { nativeSessionHash: job.nativeSessionHash }
          : {}),
        native,
        additionalNativeCalls: job.additionalCalls,
      };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", aborted);
      controller.abort();
      jobs.delete(session);
    }
  }
}

// Evidence-only projection, not an outbound rewrite or signature verifier.
// Pinned to normal Anthropic gateway history; unsupported flows stay inconclusive.
function privateClaudeComparison(original, actual, projection) {
  if (!projection.supported)
    return {
      expected: original,
      actual,
      supported: false,
      reason: projection.reason,
    };
  const expected = structuredClone(projection.projectedBody);
  const observed = structuredClone(actual);
  if (!projection.diagnostics.continuationRequired)
    return { expected, actual: observed, supported: true, reason: null };
  const block = expected.system?.at(-1);
  const exact = (value) =>
    value &&
    Object.keys(value).sort().join(",") === "text,type" &&
    value.type === "text" &&
    typeof value.text === "string";
  if (
    !Array.isArray(original.system) ||
    !Array.isArray(expected.system) ||
    !Array.isArray(observed.system) ||
    !exact(block) ||
    expected.system.length !== original.system.length + 1 ||
    original.system.some((item) => item.text === block.text) ||
    expected.system.filter((item) => item.text === block.text).length !== 1 ||
    observed.system.filter((item) => item.text === block.text).length !== 1 ||
    !exact(observed.system.at(-1)) ||
    !isDeepStrictEqual(block, observed.system.at(-1))
  )
    return {
      expected,
      actual: observed,
      supported: false,
      reason: "runtime_continuation_tail_not_exact",
    };
  // The projector/checkpoint establishes this exact new tail. Validate it in its
  // actual position before ordinary verification adds GUIDE before that tail.
  expected.system.pop();
  observed.system.pop();
  return { expected, actual: observed, supported: true, reason: null };
}

function normalizeAllowedHistory(source, actual) {
  const body = structuredClone(source);
  const unsupported = new Set();
  const report = {
    version: "anthropic-allowed-history-v2",
    supported: true,
    stampAuthenticationVerified: false,
    restoredIdSites: 0,
    restoredTextStamps: 0,
    strippedSessionReceipts: 0,
    omittedDirectCallers: 0,
    sources: [
      "backend/src/openappa/trajectory-stamp.ts:41-68,109-116,125-132 (parseTrajectoryStamp,restoreTrajectoryStampText)",
      "backend/src/openappa/session-token.ts:3-10,24-46,81-97 (stripSessionReceipts,adjacentNewlines)",
      "backend/src/openappa/wire.ts:1423-1590 (callIdSites,historyTextSites,toolResultTextSites)",
      "backend/src/routes/proxy/llm-proxy-handler.ts:695-746",
      "backend/src/types/llm-providers/anthropic/messages.ts:101-107,166-181 (request parsing strips optional direct caller)",
    ],
    limitations: [
      "Ordinary normalization covers stamps, direct-caller omission and session receipts; remedy history uses independently bound private source witnesses when enabled.",
      "No normalization of system, metadata, thinking, signatures, ordinary arguments or result structure.",
      "Existing verifyCapture pins declaration sanitization and ON guidance; unexpected changes fail equality.",
      "Only exact caller:{type:direct} absent on the corresponding captured tool_use may be projected away; this is not raw-wire equality or support for server/programmatic callers.",
    ],
  };
  const text = (value, receipts) => {
    if (
      /appact2-|appac1-|\[appa\] delegated trajectory |finished subagent /.test(
        value,
      )
    )
      unsupported.add("delegation_or_child_carrier");
    let next = value;
    if (receipts) {
      const matches = [
        ...next.matchAll(new RegExp(SESSION_RECEIPT_PATTERN, "g")),
      ].slice(0, 64);
      for (const match of matches.reverse()) {
        const start = match.index;
        const end = start + match[0].length;
        next =
          next.slice(0, start - adjacentNewlines(next, start, -1)) +
          next.slice(end + adjacentNewlines(next, end, 1));
      }
      report.strippedSessionReceipts += matches.length;
    }
    return next.replace(STAMP_IN_TEXT, (token) => {
      const restored = providerCallId(token);
      if (restored === token) return token;
      report.restoredTextStamps++;
      return restored;
    });
  };
  const textParts = (holder, key, receipts) => {
    if (typeof holder[key] === "string")
      holder[key] = text(holder[key], receipts);
    else if (Array.isArray(holder[key]))
      for (const block of holder[key])
        if (TEXT_TYPES.has(block.type) && typeof block.text === "string")
          block.text = text(block.text, receipts);
  };
  for (const [messageIndex, message] of (body.messages ?? []).entries()) {
    if (["user", "assistant"].includes(message.role))
      textParts(message, "content", true);
    if (!Array.isArray(message.content)) continue;
    for (const [blockIndex, block] of message.content.entries()) {
      const idKey =
        block.type === "tool_use"
          ? "id"
          : block.type === "tool_result"
            ? "tool_use_id"
            : null;
      if (idKey && typeof block[idKey] === "string") {
        const restored = providerCallId(block[idKey]);
        if (restored !== block[idKey]) report.restoredIdSites++;
        block[idKey] = restored;
      }
      if (block.type === "tool_result") textParts(block, "content", false);
      if (block.type === "tool_use") {
        const counterpart =
          actual.messages?.[messageIndex]?.content?.[blockIndex];
        if (
          message.role === "assistant" &&
          block.caller?.type === "direct" &&
          Object.keys(block.caller).length === 1 &&
          counterpart?.type === "tool_use" &&
          counterpart.id === block.id &&
          counterpart.name === block.name &&
          !Object.hasOwn(counterpart, "caller")
        ) {
          delete block.caller;
          report.omittedDirectCallers++;
        }
        if (/(?:^|__)get_remedy_plans$/.test(block.name ?? ""))
          unsupported.add("notice_history");
        if (/(?:^|__)execute_remedy_plan$/.test(block.name ?? ""))
          unsupported.add("remedy_history");
        if (
          /(?:^|__)ask_user$/.test(block.name ?? "") &&
          (Object.hasOwn(block.input ?? {}, "trajectory") ||
            Object.hasOwn(block.input ?? {}, "remedy_offers"))
        )
          unsupported.add("stamped_question_history");
      }
    }
  }
  report.unsupported = [...unsupported].sort();
  report.supported = unsupported.size === 0;
  return { body, report };
}

function providerCallId(id) {
  if (!id.startsWith("appat1") || id.length <= 28) return id;
  const payload = id.slice(6, -22);
  const tag = id.slice(-22);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(tag))
    return id;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== payload) return id;
  const separator = decoded.indexOf("\u0000");
  return separator > 0 && separator < decoded.length - 1
    ? decoded.slice(separator + 1)
    : id;
}

function adjacentNewlines(text, index, direction) {
  let at = index;
  for (let count = 0; count < 2; count++) {
    if (direction < 0 && text[at - 1] === "\n")
      at -= text[at - 2] === "\r" ? 2 : 1;
    else if (direction > 0 && text[at] === "\r" && text[at + 1] === "\n")
      at += 2;
    else if (direction > 0 && text[at] === "\n") at++;
    else break;
  }
  return Math.abs(at - index);
}

// Match only verifyCapture's existing message/text-shape projection. This is a
// diagnostic, not another normalization or a relaxation of evidence equality.
function firstMessageDifference(expected, actual) {
  const project = (messages) =>
    Array.isArray(messages)
      ? messages.map((message) =>
          message.role
            ? {
                ...message,
                type: message.type ?? "message",
                content:
                  typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : Array.isArray(message.content)
                      ? message.content.map((block) =>
                          TEXT_TYPES.has(block?.type)
                            ? { ...block, type: "text" }
                            : block,
                        )
                      : message.content,
              }
            : message,
        )
      : messages;
  const summary = (value) => {
    if (value === MISSING_VALUE)
      return { type: "missing", length: null, jsonBytes: 0, hash: null };
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const encoded = JSON.stringify(value);
    return {
      type,
      length:
        type === "string" || type === "array"
          ? value.length
          : type === "object"
            ? Object.keys(value).length
            : null,
      jsonBytes: encoded === undefined ? 0 : Buffer.byteLength(encoded),
      hash: encoded === undefined ? null : byteHash(Buffer.from(encoded)),
    };
  };
  const walk = (left, right, path) => {
    if (Object.is(left, right)) return null;
    if (Array.isArray(left) && Array.isArray(right)) {
      for (
        let index = 0;
        index < Math.max(left.length, right.length);
        index++
      ) {
        const difference = walk(
          index < left.length ? left[index] : MISSING_VALUE,
          index < right.length ? right[index] : MISSING_VALUE,
          `${path}/${index}`,
        );
        if (difference) return difference;
      }
      return null;
    }
    if (
      left &&
      right &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      for (const key of [
        ...new Set([...Object.keys(left), ...Object.keys(right)]),
      ].sort()) {
        // Application-defined keys can themselves contain private values.
        const segment = DIAGNOSTIC_PATH_KEYS.has(key)
          ? key
          : `@sha256:${digest(key)}`;
        const difference = walk(
          Object.hasOwn(left, key) ? left[key] : MISSING_VALUE,
          Object.hasOwn(right, key) ? right[key] : MISSING_VALUE,
          `${path}/${segment}`,
        );
        if (difference) return difference;
      }
      return null;
    }
    return { path, expected: summary(left), actual: summary(right) };
  };
  const result = walk(project(expected), project(actual), "/messages");
  return result
    ? {
        ...result,
        comparison:
          "supported-history-normalization-plus-existing-verifyCapture-message-shapes",
        hashEncoding: "json-value-sha256",
        unknownPathKeys: "sha256-redacted",
      }
    : null;
}

function describeWirePrefix(record, previous) {
  const body = record.body;
  const reencoded = Buffer.from(JSON.stringify(body));
  const prompt = {
    tools: body.tools ?? [],
    system: body.system ?? [],
    messages: body.messages ?? [],
  };
  const promptBytes = Buffer.from(JSON.stringify(prompt));
  const rawHash = safeHash(record.requestHash);
  const reencodedMatchesWire =
    rawHash !== null && rawHash === byteHash(reencoded);
  const sections = Object.fromEntries(
    Object.entries(prompt).map(([key, value]) => [key, digest(value)]),
  );
  const firstChangedSection = previous
    ? (["tools", "system", "messages"].find(
        (key) => sections[key] !== previous.sections[key],
      ) ?? null)
    : null;
  const messageHashes = prompt.messages.map(digest);
  const blockHashes = prompt.messages.map((message) =>
    Array.isArray(message.content)
      ? message.content.map(digest)
      : [digest(message.content)],
  );
  const changedMessage =
    previous && firstChangedSection === "messages"
      ? firstDifferentIndex(previous.messageHashes, messageHashes)
      : null;
  const changedBlock =
    changedMessage !== null && previous
      ? firstDifferentIndex(
          previous.blockHashes[changedMessage] ?? [],
          blockHashes[changedMessage] ?? [],
        )
      : null;
  return {
    state: {
      reencoded,
      promptBytes,
      reencodedMatchesWire,
      sections,
      messageHashes,
      blockHashes,
    },
    report: {
      relayRequestHash: rawHash,
      relayRawPrefixHash: safeHash(record.rawPrefixDigest),
      relayRawPrefixBytes: finite(record.rawPrefixBytes),
      reserializedRequestHash: byteHash(reencoded),
      reserializedRequestBytes: reencoded.length,
      reserializedBytesMatchWire: reencodedMatchesWire,
      commonRequestPrefixBytes: previous
        ? commonPrefixBytes(previous.reencoded, reencoded)
        : null,
      commonRequestPrefixIsRawWire: previous
        ? previous.reencodedMatchesWire && reencodedMatchesWire
        : false,
      promptOrderEncoding:
        "tools-system-messages-json-v1-not-provider-tokenization",
      promptOrderHash: byteHash(promptBytes),
      promptOrderBytes: promptBytes.length,
      commonPromptPrefixBytes: previous
        ? commonPrefixBytes(previous.promptBytes, promptBytes)
        : null,
      previousPromptBytes: previous?.promptBytes.length ?? null,
      firstChangedSection,
      firstChangedMessageIndex: changedMessage,
      firstChangedBlockIndex: changedBlock,
      toolsHash: sections.tools,
      systemHash: sections.system,
      historyHash: sections.messages,
      cacheMarkers: cacheMarkerOwners(body),
      limitation:
        "Hashes/common prefixes describe captured JSON, not provider token/cache keys; raw equality is claimed only when relay and reserialization hashes match.",
    },
  };
}

function cacheMarkerOwners(body) {
  const tools = body.tools ?? [];
  const system =
    typeof body.system === "string"
      ? [{ type: "text", text: body.system }]
      : (body.system ?? []);
  const messages = body.messages ?? [];
  const markers = [];
  const add = (block, position, prefix) => {
    if (!block.cache_control) return;
    const { cache_control: control, ...content } = block;
    markers.push({
      ...position,
      controlHash: digest(control),
      ownerContentHash: digest(content),
      promptThroughOwnerHash: digest(prefix),
    });
  };
  tools.forEach((tool, toolIndex) => {
    add(
      tool,
      { section: "tools", toolIndex },
      { tools: tools.slice(0, toolIndex + 1) },
    );
  });
  system.forEach((block, blockIndex) => {
    add(
      block,
      { section: "system", blockIndex },
      { tools, system: system.slice(0, blockIndex + 1) },
    );
  });
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      const prefix = {
        tools,
        system,
        messages: [
          ...messages.slice(0, messageIndex),
          { ...message, content: message.content.slice(0, blockIndex + 1) },
        ],
      };
      add(block, { section: "messages", messageIndex, blockIndex }, prefix);
    });
  });
  return markers;
}

function commonPrefixBytes(left, right) {
  let index = 0;
  while (
    index < Math.min(left.length, right.length) &&
    left[index] === right[index]
  )
    index++;
  return index;
}

function firstDifferentIndex(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++)
    if (left[index] !== right[index]) return index;
  return null;
}

function byteHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

async function decodeProviderError(stream, status) {
  let value;
  try {
    value = JSON.parse(await boundedText(stream));
  } catch {
    value = null;
  }
  const type = value?.error?.type;
  const providerErrorType = [
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "rate_limit_error",
    "overloaded_error",
    "api_error",
    "not_found_error",
    "request_too_large",
  ].includes(type)
    ? type
    : null;
  const message =
    typeof value?.error?.message === "string"
      ? value.error.message
      : typeof value?.error === "string"
        ? value.error
        : typeof value?.message === "string"
          ? value.message
          : "";
  let providerErrorCategory = null;
  if (
    /thinking/i.test(message) &&
    /tool_choice|tool choice/i.test(message) &&
    /forc|auto|not support|incompatible/i.test(message)
  )
    providerErrorCategory = "forced_tool_choice_with_thinking";
  else if (
    /thinking/i.test(message) &&
    /budget|max_tokens|token limit/i.test(message)
  )
    providerErrorCategory = "thinking_budget";
  else if (/input_schema|json schema|tool.{0,40}schema/i.test(message))
    providerErrorCategory = "invalid_schema";
  else if (
    /context.{0,30}(limit|length|window)|prompt.{0,20}too long|too many input tokens/i.test(
      message,
    )
  )
    providerErrorCategory = "context_limit";
  else if (
    [401, 403].includes(status) ||
    /OAuth|scope|authentication/i.test(message)
  )
    providerErrorCategory = "auth_scope";
  else if (status === 429 || /quota|usage limit|rate limit/i.test(message))
    providerErrorCategory = "quota";
  else if (
    /^The model provider closed the connection before the response finished/.test(
      message,
    )
  )
    providerErrorCategory = "upstream_connection_closed";
  else if (/^Could not connect to the model provider\./.test(message))
    providerErrorCategory = "upstream_unreachable";
  else if (
    /^The model provider did not finish the response in time/.test(message)
  )
    providerErrorCategory = "upstream_timeout";
  else if (/OpenAPPA/i.test(message))
    providerErrorCategory = "openappa_refusal";
  return {
    message: null,
    complete: false,
    ttftMs: null,
    providerErrorType,
    providerErrorCategory,
    providerErrorMessageHash: message ? digest(message) : null,
  };
}

async function decodeMessage(stream, start) {
  let message = null;
  let complete = false;
  let ttftMs = null;
  let buffer = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  const inputs = new Map();
  const open = new Set();
  const event = (frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const value = JSON.parse(data);
    if (value.type === "error") throw new Error("provider_stream_error");
    if (value.type === "message_start") {
      assert.ok(!message);
      message = structuredClone(value.message);
      assert.ok(message.role === "assistant" && Array.isArray(message.content));
    } else if (value.type === "content_block_start") {
      assert.ok(message && !message.content[value.index]);
      message.content[value.index] = structuredClone(value.content_block);
      open.add(value.index);
      if (["tool_use", "server_tool_use"].includes(value.content_block.type))
        ttftMs ??= performance.now() - start;
    } else if (value.type === "content_block_delta") {
      assert.ok(open.has(value.index));
      const block = message.content[value.index];
      const delta = value.delta;
      if (delta.type === "input_json_delta")
        inputs.set(
          value.index,
          (inputs.get(value.index) ?? "") + delta.partial_json,
        );
      else if (delta.type === "text_delta")
        block.text = (block.text ?? "") + delta.text;
      else if (delta.type === "thinking_delta")
        block.thinking = (block.thinking ?? "") + delta.thinking;
      else if (delta.type === "signature_delta")
        block.signature = (block.signature ?? "") + delta.signature;
      else if (delta.type === "citations_delta") {
        block.citations ??= [];
        block.citations.push(delta.citation);
      } else throw new Error("unsupported_provider_delta");
      if (
        ["text_delta", "thinking_delta", "input_json_delta"].includes(
          delta.type,
        )
      )
        ttftMs ??= performance.now() - start;
    } else if (value.type === "content_block_stop") {
      assert.ok(open.delete(value.index));
      if (inputs.has(value.index))
        message.content[value.index].input = JSON.parse(
          inputs.get(value.index),
        );
    } else if (value.type === "message_delta") {
      assert.ok(message);
      Object.assign(message, value.delta);
      message.usage = { ...message.usage, ...value.usage };
    } else if (value.type === "message_stop") {
      assert.ok(message && !open.size && message.stop_reason);
      complete = true;
    }
  };
  for await (const part of stream) {
    bytes += part.byteLength;
    assert.ok(bytes <= MAX_BYTES);
    buffer += decoder.decode(part, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      event(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) event(buffer);
  return { message, complete, ttftMs };
}

async function boundedText(stream) {
  const parts = [];
  let bytes = 0;
  for await (const part of stream) {
    bytes += part.byteLength;
    assert.ok(bytes <= MAX_BYTES);
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts).toString("utf8");
}

function forwardHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        ![
          "host",
          "connection",
          "content-length",
          "transfer-encoding",
          "accept-encoding",
          "content-encoding",
          "keep-alive",
          "upgrade",
        ].includes(name.toLowerCase()),
    ),
  );
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}
function numeric(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, item]) => Number.isFinite(item)),
  );
}
function safeNative(value) {
  return {
    ok: value?.ok === true,
    error: [
      "provider_quota",
      "provider_authentication_or_scope",
      "native_client_error",
      "native_output_not_json",
    ].includes(value?.error)
      ? value.error
      : null,
    nativeUsage: numeric(value?.nativeUsage),
    nativeModelUsage: Object.fromEntries(
      Object.entries(value?.nativeModelUsage ?? {})
        .filter(([model]) => /^claude-[a-z0-9-]{1,100}$/i.test(model))
        .map(([model, usage]) => [model, numeric(usage)]),
    ),
  };
}
function failed(error) {
  return {
    ok: false,
    status: null,
    error,
    usage: null,
    content: [],
    message: null,
    evidence: { missing: true, modeLive: false },
  };
}

const MAX_BYTES = 4 * 1024 * 1024;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const TEXT_TYPES = new Set(["text", "input_text", "output_text"]);
const MISSING_VALUE = Symbol("missing-message-value");
const DIAGNOSTIC_PATH_KEYS = new Set([
  "role",
  "type",
  "content",
  "text",
  "thinking",
  "signature",
  "id",
  "name",
  "input",
  "tool_use_id",
  "is_error",
  "cache_control",
  "ttl",
  "citations",
  "source",
  "data",
  "media_type",
  "_meta",
  "structuredContent",
  "arguments",
  "notice",
  "offers",
  "execution",
  "trajectory",
]);
const STAMP_IN_TEXT =
  /(?<![A-Za-z0-9_-])appat1[A-Za-z0-9_-]{23,}(?![A-Za-z0-9_-])/g;
const SESSION_RECEIPT_PATTERN =
  "\u2584\u2588\u2584\u2584\u2584\u2588\u2584\\r?\\n\u2588\u2588\u2584\u2588\u2584\u2588\u2588 {2}(?:started )?protected session ([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4})|\u2584\u2588\u2584\u2584\u2584\u2588\u2584 {2}(?:started )?protected session ([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4})\\r?\\n\u2588\u2588\u2584\u2588\u2584\u2588\u2588";
