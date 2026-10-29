import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  buildBody,
  DEFERRED,
  PROVIDERS,
  SCENARIOS,
  sessionId,
} from "./live-ab-scenarios.mjs";
import { summarize } from "./measure.mjs";

export function normalizeUsage(provider, raw) {
  if (!raw || typeof raw !== "object") return null;
  const number = (value) =>
    Number.isFinite(value) && value >= 0 ? value : null;
  const output = number(raw.output_tokens ?? raw.completion_tokens);
  const read = number(
    raw.cache_read_input_tokens ??
      raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens,
  );
  const write = number(
    raw.cache_creation_input_tokens ??
      raw.input_tokens_details?.cache_write_tokens ??
      raw.prompt_tokens_details?.cache_write_tokens ??
      raw.cache_write_tokens,
  );
  const input = number(raw.input_tokens ?? raw.prompt_tokens);
  const total =
    provider === "anthropic"
      ? input !== null && read !== null && write !== null
        ? input + read + write
        : null
      : input;
  return {
    totalInput: total,
    uncachedInput:
      provider === "anthropic"
        ? input
        : input !== null && read !== null && write !== null
          ? input - read - write
          : null,
    cacheRead: read,
    cacheWrite: write,
    output,
    cacheWrite5m: number(raw.cache_creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: number(raw.cache_creation?.ephemeral_1h_input_tokens),
  };
}

export async function requestCompletion({
  url,
  headers = {},
  body,
  provider,
  timeoutMs = 60000,
  maxResponseBytes = 4 * 1024 * 1024,
  fetchImpl = fetch,
}) {
  const start = performance.now();
  let status = null;
  let ttftMs = null;
  let rawUsage = null;
  let responseModel = null;
  const observeModel = (value) => {
    if (
      typeof value === "string" &&
      /^(?:gpt|claude|codex|chatgpt|o[0-9]|test|mock)[a-z0-9_.:-]{0,120}$/i.test(
        value,
      )
    )
      responseModel = value;
  };
  let text = "";
  let terminal = false;
  let shape = false;
  let toolCall = false;
  let providerErrorType = null;
  const record = () => ({
    status,
    providerErrorType,
    responseModel,
    startUnixMs: performance.timeOrigin + start,
    latencyMs: performance.now() - start,
    ttftMs,
    rawUsage: numericUsage(rawUsage),
    usage: normalizeUsage(provider, rawUsage),
    responseShape: shape,
    semanticOk: text.trim() === "BENCH_OK" && !toolCall,
  });
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    status = response.status;
    if (!response.ok) {
      let errorBytes = 0,
        errorBody = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        errorBytes += chunk.length;
        if (errorBytes > 16384) break;
        errorBody += decoder.decode(chunk, { stream: true });
      }
      try {
        const error = JSON.parse(errorBody + decoder.decode()).error;
        const category = error?.type ?? error?.code;
        if (
          [
            "invalid_request_error",
            "rate_limit_error",
            "authentication_error",
            "permission_error",
            "not_found_error",
            "api_error",
            "overloaded_error",
            "server_error",
            "invalid_api_key",
            "insufficient_quota",
          ].includes(category)
        )
          providerErrorType = category;
      } catch {
        /* Ignore nonstandard error payloads; never record raw messages. */
      }
      return { ...record(), ok: false, error: `http_${status}` };
    }
    const consume = (event) => {
      if (
        event.error ||
        event.type === "error" ||
        event.type === "response.failed"
      )
        throw new Error("provider_error");
      if (provider === "anthropic") {
        if (event.type === "message_start") {
          observeModel(event.message?.model);
          shape = event.message?.type === "message";
          rawUsage = event.message?.usage ?? rawUsage;
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        )
          addText(event.delta.text);
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        )
          toolCall = true;
        if (event.type === "message_delta" && event.usage)
          rawUsage = { ...rawUsage, ...event.usage };
        if (event.type === "message_stop") terminal = true;
      } else if (provider === "openai-chat") {
        observeModel(event.model);
        shape ||= Array.isArray(event.choices);
        if (event.usage) rawUsage = event.usage;
        for (const choice of event.choices ?? []) {
          if (choice.delta?.content) addText(choice.delta.content);
          if (choice.delta?.tool_calls) toolCall = true;
        }
      } else {
        if (event.type === "response.output_text.delta") addText(event.delta);
        if (event.type === "response.completed") {
          shape =
            event.response?.object === "response" &&
            event.response?.status === "completed";
          terminal = true;
          rawUsage = event.response?.usage ?? null;
          observeModel(event.response?.model);
        }
        if (
          event.type === "response.output_item.added" &&
          event.item?.type === "function_call"
        )
          toolCall = true;
      }
    };
    const addText = (value) => {
      if (typeof value === "string" && value.length) {
        ttftMs ??= performance.now() - start;
        text += value;
      }
    };
    let bytes = 0;
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxResponseBytes) throw new Error("response_too_large");
      buffer += decoder.decode(chunk, { stream: true });
      if (body.stream) {
        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data === "[DONE]") terminal = true;
          else if (data) consume(JSON.parse(data));
        }
      }
    }
    buffer += decoder.decode();
    if (body.stream) {
      if (!terminal || buffer.trim()) throw new Error("incomplete_stream");
    } else {
      const value = JSON.parse(buffer);
      observeModel(value.model);
      if (value.error) throw new Error("provider_error");
      rawUsage = value.usage ?? null;
      if (provider === "anthropic") {
        shape = value.type === "message" && Array.isArray(value.content);
        text = (value.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        toolCall = value.content?.some((c) => c.type === "tool_use");
      } else if (provider === "openai-chat") {
        shape =
          value.object === "chat.completion" && Array.isArray(value.choices);
        text = value.choices?.[0]?.message?.content ?? "";
        toolCall = !!value.choices?.[0]?.message?.tool_calls?.length;
      } else {
        shape =
          value.object === "response" &&
          value.status === "completed" &&
          Array.isArray(value.output);
        text = (value.output ?? [])
          .flatMap((item) => item.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("");
        toolCall = value.output?.some((c) => c.type === "function_call");
      }
    }
    const result = record();
    if (!shape || !result.semanticOk)
      return {
        ...result,
        ok: false,
        error: !shape ? "invalid_response_shape" : "semantic_mismatch",
      };
    return { ...result, ok: true, error: null };
  } catch (error) {
    // Never persist provider bodies or arbitrary exception messages (credentials
    // can appear in upstream errors). Partial usage is not a successful sample.
    rawUsage = null;
    return {
      ...record(),
      ok: false,
      error: [
        "provider_error",
        "response_too_large",
        "incomplete_stream",
      ].includes(error.message)
        ? error.message
        : "transport_or_parse_error",
    };
  }
}

export function summarizePairs(rows) {
  const cells = new Map();
  for (const row of rows.filter((r) => r.phase === "sample")) {
    const key = `${row.provider}/${row.scenario}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row);
  }
  return Array.from(cells, ([cell, samples]) => {
    const arms = Object.fromEntries(
      ["off", "on"].map((arm) => {
        const all = samples.filter((r) => r.arm === arm);
        const good = all.filter((r) => r.ok);
        const cacheObserved = good.filter((r) =>
          Number.isFinite(r.usage?.cacheRead),
        );
        const completeUsage = good.filter(
          (r) =>
            Number.isFinite(r.usage?.cacheRead) &&
            Number.isFinite(r.usage?.totalInput),
        );
        const inputSum = completeUsage.reduce(
          (sum, r) => sum + r.usage.totalInput,
          0,
        );
        return [
          arm,
          {
            attempted: all.length,
            successful: good.length,
            errors: all.filter((r) => !r.ok).length,
            missingUsage: good.filter(
              (r) =>
                !r.usage ||
                r.usage.totalInput == null ||
                r.usage.cacheRead == null,
            ).length,
            cacheObserved: cacheObserved.length,
            cacheHits: cacheObserved.filter((r) => r.usage.cacheRead > 0)
              .length,
            requestHitFraction: cacheObserved.length
              ? cacheObserved.filter((r) => r.usage.cacheRead > 0).length /
                cacheObserved.length
              : null,
            cacheReadInputRatio:
              inputSum > 0
                ? completeUsage.reduce((sum, r) => sum + r.usage.cacheRead, 0) /
                  inputSum
                : null,
            latencyMs: summarize(good.map((r) => r.latencyMs)),
            ttftMs: summarize(
              good.map((r) => r.ttftMs).filter(Number.isFinite),
            ),
            cacheRead: summarize(
              good.map((r) => r.usage?.cacheRead).filter(Number.isFinite),
            ),
            totalInput: summarize(
              good.map((r) => r.usage?.totalInput).filter(Number.isFinite),
            ),
            output: summarize(
              good.map((r) => r.usage?.output).filter(Number.isFinite),
            ),
          },
        ];
      }),
    );
    const off = new Map(
      samples
        .filter((r) => r.arm === "off")
        .map((r) => [`${r.block}/${r.lane ?? 0}/${r.sample}`, r]),
    );
    const pairs = samples
      .filter((r) => r.arm === "on")
      .map((on) => ({
        on,
        off: off.get(`${on.block}/${on.lane ?? 0}/${on.sample}`),
      }))
      .filter((p) => p.on.ok && p.off?.ok);
    const difference = (getter) =>
      summarize(
        pairs
          .map((p) => {
            const a = getter(p.on),
              b = getter(p.off);
            return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
          })
          .filter(Number.isFinite),
      );
    const hitBaseline = samples.some(
      (r) => r.arm === "off" && r.ok && r.usage?.cacheRead > 0,
    );
    const evidence =
      samples
        .filter((r) => r.arm === "on" && r.ok)
        .every((r) => r.evidence?.rewriteProven === true) &&
      arms.on.successful > 0;
    const reasons = [];
    const observedModels = [
      ...new Set(
        samples
          .filter((r) => r.ok && r.responseModel)
          .map((r) => r.responseModel),
      ),
    ];
    if (observedModels.length > 1) reasons.push("provider_model_drift");
    if (!hitBaseline) reasons.push("no_observed_baseline_cache_hits");
    if (!evidence) reasons.push("rewrite_not_proven_for_all_on_samples");
    if (samples.some((r) => r.evidence?.mode !== "live"))
      reasons.push("capture_not_live_or_missing");
    if (samples.some((r) => r.arm === "off" && r.evidence?.offClean !== true))
      reasons.push("off_arm_not_proven_unrewritten");
    if (
      pairs.length !== arms.off.attempted ||
      pairs.length !== arms.on.attempted
    )
      reasons.push("unpaired_or_failed_samples");
    if (
      pairs.some(
        (p) =>
          p.on.usage?.totalInput == null ||
          p.off.usage?.totalInput == null ||
          p.on.usage?.cacheRead == null ||
          p.off.usage?.cacheRead == null,
      )
    )
      reasons.push("usage_missing");
    return {
      cell,
      arms,
      pairedSamples: pairs.length,
      observedModels,
      deltaOnMinusOff: {
        latencyMs: difference((r) => r.latencyMs),
        ttftMs: difference((r) => r.ttftMs),
        totalInput: difference((r) => r.usage?.totalInput),
        cacheRead: difference((r) => r.usage?.cacheRead),
        cacheWrite: difference((r) => r.usage?.cacheWrite),
        output: difference((r) => r.usage?.output),
      },
      inconclusive: reasons.length > 0,
      reasons,
      conclusion: reasons.length
        ? "inconclusive"
        : "paired_deltas_with_cache_and_rewrite_evidence",
    };
  });
}

export async function withDeployment({ api, work, onRestored = () => {} }) {
  const prior = await api("GET", "/api/guardrails-deployment");
  const hasBreakTheGlass = Object.hasOwn(prior, "breakTheGlassEnabled");
  const editable = ({
    enabled,
    unsupportedClientAction,
    breakTheGlassEnabled,
    superyellEnabled,
  }) =>
    hasBreakTheGlass
      ? { enabled, unsupportedClientAction, breakTheGlassEnabled }
      : { enabled, unsupportedClientAction, superyellEnabled };
  const set = async (enabled) => {
    await api(
      "PUT",
      "/api/guardrails-deployment",
      hasBreakTheGlass
        ? {
            enabled,
            unsupportedClientAction: "block",
            breakTheGlassEnabled: false,
          }
        : {
            enabled,
            unsupportedClientAction: "block",
            superyellEnabled: false,
          },
    );
    const actual = await api("GET", "/api/guardrails-deployment");
    const emergencyOff = hasBreakTheGlass
      ? actual.breakTheGlassEnabled === false
      : actual.superyellEnabled === false;
    if (
      actual.enabled !== enabled ||
      actual.active !== enabled ||
      actual.unsupportedClientAction !== "block" ||
      !emergencyOff
    )
      throw new Error("deployment_verification_failed");
    return actual;
  };
  let result, workError, restorationError;
  try {
    result = await work({ set, prior });
  } catch (error) {
    workError = error;
  } finally {
    try {
      await api("PUT", "/api/guardrails-deployment", editable(prior));
      const restored = await api("GET", "/api/guardrails-deployment");
      if (
        JSON.stringify(editable(restored)) !== JSON.stringify(editable(prior))
      )
        restorationError = new Error("deployment_restoration_failed");
      else onRestored();
    } catch {
      restorationError = new Error("deployment_restoration_failed");
    }
  }
  if (restorationError) throw restorationError;
  if (workError) throw workError;
  return result;
}

export function normalizeCodexTransport(body) {
  if (!Array.isArray(body.input) || body.messages || body.system)
    throw new Error("codex_requires_responses_input");
  const expected = structuredClone(body);
  delete expected.max_output_tokens;
  expected.store = false;
  expected.stream = true;
  expected.include = Array.from(
    new Set([
      ...(Array.isArray(expected.include) ? expected.include : []),
      "reasoning.encrypted_content",
    ]),
  );
  if (
    expected.instructions == null &&
    !expected.input.some(
      (item) => item && ["developer", "system"].includes(item.role),
    )
  ) {
    expected.instructions =
      "You are a coding agent running in Archestra, powered by a GPT-5 Codex model accessed through the user's ChatGPT subscription. Follow the user's and the developer's instructions, use the provided tools when helpful, and be concise and correct.";
  }
  return expected;
}

export function verifyCapture(
  body,
  capture,
  arm,
  { codexSubscription = false } = {},
) {
  const toolName = (t) => t.name ?? t.function?.name;
  const sourceTools = body.tools ?? [];
  const sentTools = capture?.tools ?? [];
  const notice = (tool) =>
    /(?:^|__)get_remedy_plans$/.test(toolName(tool) ?? "");
  const control = (tool) =>
    /(?:^|__)execute_remedy_plan$/.test(toolName(tool) ?? "");
  // prepareAppaRequest strips get_remedy_plans before the provider; the
  // model-visible execute_remedy_plan declaration is the actual rewrite witness.
  const injected = sentTools.some(control) && !sourceTools.some(control);
  const connectedRewrite =
    sourceTools.some(notice) &&
    sourceTools.some(control) &&
    !sentTools.some(notice) &&
    sentTools.some(control);
  // Both arms sanitize proxy-only transport fields; ON additionally withholds
  // the notice declaration. This exception applies only to real remedy names.
  const expectedTools = sourceTools
    .filter((tool) => arm !== "on" || !notice(tool))
    .map(cleanGatewayDeclaration);
  const originalNames = new Set(expectedTools.map(toolName).filter(Boolean));
  const projectedTools = sentTools.filter((t) =>
    originalNames.has(toolName(t)),
  );
  const addedTools = sentTools.filter(
    (tool) => !originalNames.has(toolName(tool)),
  );
  const allowedAdditions =
    addedTools.length === 0 ||
    (injected && addedTools.length === 1 && control(addedTools[0]));
  const retainedTools =
    allowedAdditions && canonical(expectedTools) === canonical(projectedTools);
  const project = (request) => {
    const { tools: _tools, ...rest } = request ?? {};
    // Anthropic may normalize system strings to text blocks; message text
    // block encodings are likewise wire-equivalent. Cache ownership remains
    // on the same block, and order/roles/call IDs/arguments stay significant.
    const content = (value) =>
      typeof value === "string"
        ? [{ type: "text", text: value }]
        : Array.isArray(value)
          ? value.map((v) =>
              v && ["text", "input_text", "output_text"].includes(v.type)
                ? { ...v, type: "text" }
                : v,
            )
          : value;
    if (rest.system !== undefined) rest.system = content(rest.system);
    for (const key of ["messages", "input"])
      if (Array.isArray(rest[key]))
        rest[key] = rest[key].map((message) =>
          message.role
            ? {
                ...message,
                type: message.type ?? "message",
                content: content(message.content),
              }
            : message,
        );
    return rest;
  };
  let expectedBody = structuredClone(body);
  // Pinned projection of plugin.ts insertRequestGuidance. Unexpected context
  // changes fail full equality instead of being ignored as substring matches.
  if (arm === "on" && sourceTools.some(control)) {
    const guidance = [REMEDY_GUIDANCE];
    const askUser = sourceTools.find((tool) =>
      /(?:^|__)ask_user$/.test(toolName(tool) ?? ""),
    );
    if (askUser)
      guidance.push(
        `When you need a decision, a clarification, a preference, or an approval from the user, ask with ${toolName(askUser)}. The user then answers in the client's question interface. Ask multiple-choice questions with ${toolName(askUser)} too, not in plain text.`,
      );
    for (const text of guidance) {
      if (Array.isArray(expectedBody.system))
        expectedBody.system.push({ type: "text", text });
      else if (typeof expectedBody.system === "string")
        expectedBody.system += `\n\n${text}`;
      else if (Array.isArray(expectedBody.messages))
        expectedBody.messages.push({ role: "developer", content: text });
      else if (Array.isArray(expectedBody.input)) {
        const start = expectedBody.input.findIndex(
          (item) => !["system", "developer"].includes(item.role),
        );
        expectedBody.input.splice(
          start < 0 ? expectedBody.input.length : start,
          0,
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text }],
          },
        );
      }
    }
  }
  if (codexSubscription) expectedBody = normalizeCodexTransport(expectedBody);
  const original = project(expectedBody),
    sent = project(capture);
  const retainedPrefix =
    canonical(original.system ?? (original.messages ?? original.input)?.[0]) ===
    canonical(sent.system ?? (sent.messages ?? sent.input)?.[0]);
  const retainedHistory =
    canonical(original.messages ?? original.input) ===
    canonical(sent.messages ?? sent.input);
  const semanticRetained = canonical(original) === canonical(sent);
  const cacheControlsRetained =
    retainedTools && retainedPrefix && retainedHistory;
  return {
    captureHash: hash(capture),
    retainedTools,
    retainedPrefix,
    retainedHistory,
    semanticRetained,
    cacheControlsRetained,
    rewriteProven:
      arm === "on" &&
      sourceTools.length > 0 &&
      (injected || connectedRewrite) &&
      semanticRetained &&
      retainedTools,
    offClean:
      arm !== "off" ||
      (canonical(original) === canonical(project(capture)) &&
        canonical(expectedTools) === canonical(sentTools)),
  };
}

export function parseOptions(args, env = process.env) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      list: { type: "boolean" },
      "dry-run": { type: "boolean" },
      live: { type: "boolean" },
      "isolated-dev": { type: "boolean" },
      "codex-subscription": { type: "boolean" },
      "cache-routing-key": { type: "boolean" },
      help: { type: "boolean" },
      base: { type: "string", default: "http://127.0.0.1:9000" },
      "proxy-base": { type: "string" },
      "capture-base": { type: "string" },
      "gateway-tools": { type: "string" },
      "evidence-url": { type: "string" },
      agent: { type: "string" },
      providers: { type: "string", default: PROVIDERS.join(",") },
      scenarios: { type: "string" },
      samples: { type: "string", default: "3" },
      blocks: { type: "string", default: "2" },
      priming: { type: "string", default: "1" },
      seed: { type: "string", default: "1605" },
      "run-id": { type: "string" },
      "timeout-ms": { type: "string", default: "60000" },
      "max-requests": { type: "string", default: "200" },
      "prefix-words": { type: "string", default: "6000" },
      "max-tokens": { type: "string", default: "64" },
      out: { type: "string", default: "/tmp/archestra-live-ab" },
      "anthropic-model": { type: "string" },
      "openai-model": { type: "string" },
    },
  });
  const options = {
    ...values,
    agent: values.agent ?? env.ARCHESTRA_BENCHMARK_AGENT,
    proxyBase: values["proxy-base"] ?? values.base,
    captureBase: values["capture-base"],
    evidenceUrl:
      values["evidence-url"] ??
      (values["capture-base"]
        ? `${values["capture-base"].replace(/\/$/, "")}/evidence`
        : undefined),
    runId: values["run-id"] ?? randomUUID(),
    timeoutMs: Number(values["timeout-ms"]),
    maxRequests: Number(values["max-requests"]),
    prefixWords: Number(values["prefix-words"]),
    maxTokens: Number(values["max-tokens"]),
    seed: Number(values.seed),
    samples: Number(values.samples),
    blocks: Number(values.blocks),
    priming: Number(values.priming),
  };
  for (const [key, max] of [
    ["samples", 100],
    ["blocks", 20],
    ["priming", 10],
    ["timeoutMs", 300000],
    ["maxRequests", 10000],
    ["prefixWords", 20000],
    ["maxTokens", 512],
    ["seed", 2147483647],
  ])
    if (
      !Number.isInteger(options[key]) ||
      options[key] < (key === "priming" || key === "seed" ? 0 : 1) ||
      options[key] > max
    )
      throw new Error(`invalid_${key}`);
  if (options.blocks % 2)
    throw new Error("blocks_must_be_even_for_AB_BA_balance");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.runId))
    throw new Error("invalid_run_id");
  options.providers = values.providers.split(",");
  if (
    options.providers.some((p) => !PROVIDERS.includes(p)) ||
    new Set(options.providers).size !== options.providers.length
  )
    throw new Error("invalid_providers");
  options.scenarios = values.scenarios
    ? values.scenarios.split(",").map((id) => {
        const s = SCENARIOS.find((s) => s.id === id);
        if (!s) throw new Error("invalid_scenarios");
        return s;
      })
    : SCENARIOS;
  if (
    new Set(options.scenarios.map((s) => s.id)).size !==
    options.scenarios.length
  )
    throw new Error("duplicate_scenarios_would_contaminate_cache");
  options.models = {
    anthropic:
      values["anthropic-model"] ?? env.ARCHESTRA_BENCHMARK_ANTHROPIC_MODEL,
    openai: values["openai-model"] ?? env.ARCHESTRA_BENCHMARK_OPENAI_MODEL,
  };
  if (options["codex-subscription"]) {
    if (
      options.providers.length !== 1 ||
      options.providers[0] !== "openai-responses"
    )
      throw new Error("codex_subscription_requires_responses_only");
    if (options.live && !values["openai-model"]?.trim())
      throw new Error("codex_subscription_requires_explicit_model");
  }
  return options;
}

export async function runLive(options, env = process.env) {
  if (!options.live || !options["isolated-dev"])
    throw new Error("live_requires_explicit_isolated_dev_acknowledgement");
  for (const address of [options.base, options.proxyBase, options.evidenceUrl])
    assertLoopback(address);
  if (options.captureBase) assertLoopback(options.captureBase);
  if (!options.agent || !/^[a-zA-Z0-9_-]+$/.test(options.agent))
    throw new Error("live_requires_agent");
  if (!env.ARCHESTRA_BENCHMARK_API_AUTH && !env.ARCHESTRA_BENCHMARK_COOKIE)
    throw new Error("missing_API_AUTH_environment_variable");
  const subscription = !!options["codex-subscription"];
  if (subscription) {
    if (
      options.providers.length !== 1 ||
      options.providers[0] !== "openai-responses" ||
      !options["openai-model"]?.trim()
    )
      throw new Error(
        "codex_subscription_requires_responses_and_explicit_model",
      );
    for (const [name, maximum] of [
      ["ARCHESTRA_BENCHMARK_CODEX_ACCESS_TOKEN", 16384],
      ["ARCHESTRA_BENCHMARK_CODEX_ACCOUNT_ID", 256],
      ["ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY", 16384],
    ]) {
      if (
        typeof env[name] !== "string" ||
        !env[name].length ||
        env[name].length > maximum ||
        !/^[!-~]+$/.test(env[name])
      )
        throw new Error("invalid_codex_subscription_environment");
    }
    if (env.ARCHESTRA_BENCHMARK_CODEX_ACCESS_TOKEN.startsWith("chatgpt-oauth:"))
      throw new Error("encoded_refresh_credentials_not_allowed");
  }
  const skips = [];
  const cells = [];
  for (const provider of options.providers)
    for (const scenario of options.scenarios) {
      const model =
        options.models[provider === "anthropic" ? "anthropic" : "openai"];
      const key = subscription
        ? env.ARCHESTRA_BENCHMARK_CODEX_ACCESS_TOKEN
        : providerKey(provider, env);
      const reason =
        scenario.providers && !scenario.providers.includes(provider)
          ? "unsupported_protocol_scenario"
          : !model || !key
            ? "provider_model_or_key_unavailable"
            : null;
      if (reason) skips.push({ provider, scenario: scenario.id, reason });
      else cells.push({ provider, scenario, model });
    }
  const requestCount =
    cells.reduce((sum, { scenario }) => sum + (scenario.concurrency ?? 1), 0) *
    options.blocks *
    2 *
    (options.samples + options.priming);
  if (requestCount > options.maxRequests)
    throw new Error("request_budget_exceeded_select_fewer_scenarios");
  if (!cells.length) throw new Error("no_available_provider_cells");
  const out = resolve(options.out, options.runId);
  await mkdir(out, { recursive: true });
  const measurements = resolve(out, "measurements.jsonl");
  // Exclusive creation prevents accidentally appending a second run to old evidence.
  await writeFile(measurements, "", { flag: "wx", mode: 0o600 });
  const rows = [];
  const deployments = [];
  let policy;
  let failure = null;
  let priorDeployment;
  let restored = false;
  let evidenceMode = "unavailable";
  let mcpDeclarations = [];
  const api = async (method, path, body) => {
    const response = await fetch(`${options.base.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        ...(env.ARCHESTRA_BENCHMARK_API_AUTH
          ? { Authorization: env.ARCHESTRA_BENCHMARK_API_AUTH }
          : { Cookie: env.ARCHESTRA_BENCHMARK_COOKIE }),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`admin_http_${response.status}`);
    }
    return response.json();
  };
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const readPolicy = await api("GET", "/api/guardrails-policy");
    policy = { revision: readPolicy.revision, hash: hash(readPolicy.content) };
    await withDeployment({
      api,
      onRestored: () => {
        restored = true;
      },
      work: async ({ set, prior }) => {
        priorDeployment = prior;
        if (options["gateway-tools"])
          mcpDeclarations = await loadMcpDeclarations(options);
        for (let block = 0; block < options.blocks; block++) {
          // Counterbalance ordering, including a seed-controlled initial reversal.
          const order =
            (block + options.seed) % 2 ? ["on", "off"] : ["off", "on"];
          for (const arm of order) {
            if (stop.signal.aborted) throw new Error("interrupted");
            deployments.push({ block, arm, state: await set(arm === "on") });
            for (const { provider, scenario, model } of cells) {
              for (
                let index = 0;
                index < options.priming + options.samples;
                index++
              ) {
                if (stop.signal.aborted) throw new Error("interrupted");
                // Each lane owns its session/cache prefix. Await the whole priming
                // wave before any warmed wave; never overlap a session with itself.
                await Promise.all(
                  Array.from(
                    { length: scenario.concurrency ?? 1 },
                    async (_, lane) => {
                      const session = sessionId({
                        runId: options.runId,
                        seed: options.seed,
                        provider,
                        scenario: `${scenario.id}/lane${lane}`,
                        block,
                        arm,
                      });
                      const sample = index - options.priming;
                      const body = buildBody({
                        provider,
                        scenario,
                        model,
                        session,
                        sample: Math.max(sample, 0),
                        prefixWords: options.prefixWords,
                        maxTokens: options.maxTokens,
                        cacheRoutingKey: options["cache-routing-key"],
                      });
                      if (scenario.tools > 0 && mcpDeclarations.length)
                        body.tools.push(
                          ...mcpDeclarations.map((tool) =>
                            projectMcpTool(tool, provider),
                          ),
                        );
                      const key = subscription
                        ? env.ARCHESTRA_BENCHMARK_CODEX_ACCESS_TOKEN
                        : providerKey(provider, env);
                      const headers = {
                        "X-Appa-Session-ID": session,
                        ...(provider === "anthropic"
                          ? {
                              "x-api-key": key,
                              "anthropic-version": "2023-06-01",
                            }
                          : { Authorization: `Bearer ${key}` }),
                        ...(subscription
                          ? {
                              "chatgpt-account-id":
                                env.ARCHESTRA_BENCHMARK_CODEX_ACCOUNT_ID,
                              "X-Archestra-Virtual-Key":
                                env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
                              "x-archestra-opencode-oauth-bridge": "true",
                              originator: "archestra",
                              ...(options["cache-routing-key"]
                                ? { "session-id": session }
                                : {}),
                            }
                          : {}),
                        ...(options.captureBase && !subscription
                          ? {
                              "X-Archestra-Provider-Base-Url": `${options.captureBase.replace(/\/$/, "")}/${provider === "anthropic" ? "anthropic" : "openai/v1"}`,
                            }
                          : {}),
                      };
                      const path =
                        provider === "anthropic"
                          ? `/v1/anthropic/${options.agent}/v1/messages`
                          : `/v1/openai/${options.agent}/${provider === "openai-chat" ? "chat/completions" : "responses"}`;
                      const evidenceUrl = new URL(options.evidenceUrl);
                      evidenceUrl.searchParams.set("sessionId", session);
                      let fence = null;
                      try {
                        const before = await readEvidence(
                          evidenceUrl,
                          options.timeoutMs,
                        );
                        fence = Math.max(
                          0,
                          ...before.records
                            .filter(
                              (r) =>
                                r.sessionId === session &&
                                Number.isInteger(r.idx),
                            )
                            .map((r) => r.idx),
                        );
                      } catch {
                        /* Without a pre-request fence no per-request evidence is admitted. */
                      }
                      const result = await requestCompletion({
                        url: `${options.proxyBase.replace(/\/$/, "")}${path}`,
                        headers,
                        body,
                        provider,
                        timeoutMs: options.timeoutMs,
                      });
                      let evidence = null;
                      try {
                        // Relay disk append can finish just after the response reaches us.
                        for (let attempt = 0; attempt < 3; attempt++) {
                          if (fence === null) break;
                          const captured = await readEvidence(
                            evidenceUrl,
                            options.timeoutMs,
                          );
                          evidenceMode = captured.mode ?? "unavailable";
                          const records = captured.records.filter(
                            (r) =>
                              r.sessionId === session &&
                              Number.isInteger(r.idx) &&
                              r.idx > fence,
                          );
                          if (records.length > 1) break;
                          if (records.length === 1 && records[0].body) {
                            const capture = records[0];
                            evidence = {
                              ...verifyCapture(body, capture.body, arm, {
                                codexSubscription: subscription,
                              }),
                              mode: evidenceMode,
                              idx: capture.idx,
                              requestIdx: capture.requestIdx ?? null,
                              status: capture.status ?? null,
                              requestHash: safeDigest(capture.requestHash),
                              leadingPrefixDigest: safeDigest(
                                capture.leadingPrefixDigest,
                              ),
                              rawPrefixDigest: safeDigest(
                                capture.rawPrefixDigest,
                              ),
                              arrivedUnixMs: Number.isFinite(
                                capture.arrivedUnixMs,
                              )
                                ? capture.arrivedUnixMs
                                : null,
                              timingsMs: numericUsage(capture.timingsMs),
                            };
                            if (subscription) {
                              evidence.subscriptionRouteProven =
                                capture.provider === "codex" &&
                                capture.protocol === "openai-responses" &&
                                capture.transport === "http-sse" &&
                                capture.authMode === "subscription";
                              evidence.rewriteProven &&=
                                evidence.subscriptionRouteProven;
                              evidence.offClean &&=
                                evidence.subscriptionRouteProven;
                            }
                            break;
                          }
                          await new Promise((done) => setTimeout(done, 25));
                        }
                      } catch {
                        /* Missing evidence is explicit and makes the cell inconclusive. */
                      }
                      const row = {
                        runId: options.runId,
                        seed: options.seed,
                        provider,
                        model,
                        scenario: scenario.id,
                        block,
                        lane,
                        concurrency: scenario.concurrency ?? 1,
                        authLane: subscription
                          ? "codex-subscription-access-token"
                          : "provider-api-key",
                        transportLane: subscription
                          ? "native-codex-responses-fixed-transcript"
                          : "provider-api-fixed-transcript",
                        connectedMcp:
                          scenario.tools > 0 && mcpDeclarations.length > 0,
                        arm,
                        order: order.join("/"),
                        session,
                        phase: sample < 0 ? "priming" : "sample",
                        sample: sample < 0 ? index : sample,
                        requestHash: hash(body),
                        ...result,
                        evidence,
                      };
                      rows.push(row);
                      await appendFile(
                        measurements,
                        `${JSON.stringify(row)}\n`,
                      );
                    },
                  ),
                );
              }
            }
          }
        }
        const finalPolicy = await api("GET", "/api/guardrails-policy");
        if (
          finalPolicy.revision !== policy.revision ||
          hash(finalPolicy.content) !== policy.hash
        )
          throw new Error("policy_changed_during_run");
      },
    });
  } catch (error) {
    failure =
      /^((admin_http_\d+)|deployment_verification_failed|deployment_restoration_failed|policy_changed_during_run|interrupted)$/.test(
        error.message,
      )
        ? error.message
        : "run_failed";
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  let revision = "unavailable";
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* Standalone copied harness has no git metadata. */
  }
  const summary = {
    version: 1,
    revision,
    harnessHash: hash(await readFile(new URL(import.meta.url), "utf8")),
    scenarioSourceHash: hash(
      await readFile(
        new URL("./live-ab-scenarios.mjs", import.meta.url),
        "utf8",
      ),
    ),
    runId: options.runId,
    seed: options.seed,
    prefixWords: options.prefixWords,
    maxTokens: options.maxTokens,
    cacheRoutingKey: !!options["cache-routing-key"],
    nativeSessionAffinity: subscription && !!options["cache-routing-key"],
    timeoutMs: options.timeoutMs,
    providers: options.providers,
    models: options.models,
    authLane: subscription
      ? "codex-subscription-access-token"
      : "provider-api-key",
    transportLane: subscription
      ? "native-codex-responses-fixed-transcript"
      : "provider-api-fixed-transcript",
    connectedMcp: !!options["gateway-tools"],
    mcpDeclarationCount: mcpDeclarations.length,
    mcpDeclarationHash: mcpDeclarations.length ? hash(mcpDeclarations) : null,
    samplesPerCell: options.samples,
    primingPerCell: options.priming,
    blocks: options.blocks,
    requestBudget: options.maxRequests,
    plannedRequests: requestCount,
    actualRequests: rows.length,
    policy,
    priorDeployment,
    deployments,
    restored,
    evidenceMode,
    failure,
    scenarios: options.scenarios,
    deferred: DEFERRED,
    skips,
    limitations: [
      "Fixed synthetic histories, not adaptive tool execution or validated remedy history.",
      "Short/tool-free requests are bypass controls, not governed rewrite evidence.",
      "Long prefix eligibility requires observed cache hits, never token-length inference.",
      "Policy content is intentionally not persisted; revision and hash pin the coordinator-provisioned policy.",
      "Latency percentiles are descriptive; small sample counts cannot support tail/no-degradation claims.",
      "Gateway recovery tools are fixed additions to nonzero workload declarations; zero-tool controls omit the gateway trio.",
      ...(subscription
        ? [
            "Access-token-only native Codex Responses bridge, not an official CLI episode or refresh workflow.",
            "Codex upstream drops max_output_tokens and always streams; timeout, response bytes and request count remain bounded.",
            "Codex routing uses the coordinator-configured backend API base; capture-base only locates evidence for this lane.",
          ]
        : []),
    ],
    errors: rows
      .filter((r) => !r.ok)
      .map(
        ({ provider, scenario, arm, block, lane, sample, phase, error }) => ({
          provider,
          scenario,
          arm,
          block,
          lane,
          sample,
          phase,
          error,
        }),
      ),
    cells: summarizePairs(rows),
  };
  await writeFile(
    resolve(out, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { out, summary };
}

function hash(value) {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function safeDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

function numericUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, v]) =>
          /^[a-z0-9_]+$/.test(key) &&
          (Number.isFinite(v) ||
            (v && typeof v === "object" && !Array.isArray(v))),
      )
      .map(([key, v]) => [key, typeof v === "number" ? v : numericUsage(v)]),
  );
}

function providerKey(provider, env) {
  return provider === "anthropic"
    ? (env.ARCHESTRA_BENCHMARK_ANTHROPIC_API_KEY ??
        env.ARCHESTRA_CHAT_ANTHROPIC_API_KEY)
    : (env.ARCHESTRA_BENCHMARK_OPENAI_API_KEY ??
        env.ARCHESTRA_CHAT_OPENAI_API_KEY);
}

async function readEvidence(url, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("capture_unavailable");
  }
  const value = await response.json();
  if (!Array.isArray(value.records)) throw new Error("invalid_capture");
  return value;
}

async function loadMcpDeclarations(options) {
  const raw = await readFile(resolve(options["gateway-tools"]), "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("gateway_fixture_too_large");
  const fixture = JSON.parse(raw);
  const tools =
    fixture.tools?.filter((tool) =>
      /(?:^|__)(?:get_remedy_plans|execute_remedy_plan|ask_user)$/.test(
        tool.name ?? "",
      ),
    ) ?? [];
  if (
    fixture.provenance?.agentId !== options.agent ||
    tools.length !== 3 ||
    tools.some(
      (tool) =>
        !/^\[\[gwa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\]\]/.test(
          tool.description ?? "",
        ) || !tool.inputSchema,
    )
  )
    throw new Error("invalid_authenticated_gateway_fixture");
  return tools;
}

function cleanGatewayDeclaration(tool) {
  const expected = structuredClone(tool);
  const holder = expected.function ?? expected;
  if (typeof holder.description === "string") {
    holder.description = holder.description.replace(
      /^\[\[gwa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\]\](?:\r?\n)?/,
      "",
    );
    if (!holder.description) delete holder.description;
  }
  const name = holder.name ?? "";
  const keys = /(?:^|__)execute_remedy_plan$/.test(name)
    ? ["execution", "trajectory", "protected", "payload", "signature"]
    : /(?:^|__)ask_user$/.test(name)
      ? ["remedy_offers", "trajectory"]
      : /(?:^|__)get_remedy_plans$/.test(name)
        ? ["offers"]
        : [];
  const schema = holder.input_schema ?? holder.parameters;
  for (const key of keys) {
    if (schema?.properties) delete schema.properties[key];
    if (schema?.required)
      schema.required = schema.required.filter((value) => value !== key);
  }
  return expected;
}

// Pinned to backend/src/proxy/plugins/appa-plugin-archestra/plugin.ts. A changed
// runtime instruction must produce inconclusive evidence until reviewed here.
const REMEDY_GUIDANCE = [
  "The organization's guardrails policy can block a tool call and offer remedy plans in its ruling.",
  "A remedy plan is the policy's own way to continue, and execute_remedy_plan applies the plan through the policy.",
  "A plan fits unless the narrower session could no longer do what the user asked for or will clearly ask next.",
  "Apply a fitting plan with execute_remedy_plan.",
  "Use the offer_id and plan from the ruling.",
  "The policy decides when the user must approve a plan.",
  "In that case, execute_remedy_plan returns review_required.",
  "Then ask the user with the declared ask_user tool.",
  "Put the offer ID in remedy_offer_ids, and use the header Approval and the options Approve and Deny.",
  "The platform shows the user the exact review.",
  "Retry the blocked call only after execute_remedy_plan reports that the plan is authorized.",
  "If a plan makes no sense, you keep getting blocked, the user keeps being asked to approve similar calls, or the user is frustrated, call yell.",
].join(" ");

function projectMcpTool(tool, provider) {
  const parameters = structuredClone(tool.inputSchema);
  if (provider === "anthropic")
    return {
      name: tool.name,
      description: tool.description,
      input_schema: parameters,
    };
  if (provider === "openai-chat")
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters },
    };
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters,
  };
}

function assertLoopback(address) {
  if (!address) throw new Error("live_requires_loopback_evidence_url");
  const url = new URL(address);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("only_loopback_bases_without_credentials_allowed");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.info(
        "node benchmarks/live-ab.mjs --list | --dry-run | --live --isolated-dev --agent ID --capture-base http://127.0.0.1:PORT [--gateway-tools benchmarks/results/gateway-tools.json --evidence-url URL --base URL --proxy-base URL --providers anthropic,openai-chat,openai-responses --scenarios IDs --samples 3 --blocks 2 --priming 1 --seed 1605 --run-id ID --max-requests 200 --timeout-ms 60000 --prefix-words 6000 --max-tokens 64 --out /tmp/archestra-live-ab --anthropic-model MODEL --openai-model MODEL]\nSecrets only environment: ARCHESTRA_BENCHMARK_API_AUTH (raw Authorization) or ARCHESTRA_BENCHMARK_COOKIE; ARCHESTRA_BENCHMARK_ANTHROPIC_API_KEY and ARCHESTRA_BENCHMARK_OPENAI_API_KEY (fallback ARCHESTRA_CHAT_*_API_KEY). Model environment: ARCHESTRA_BENCHMARK_ANTHROPIC_MODEL, ARCHESTRA_BENCHMARK_OPENAI_MODEL. Agent fallback: ARCHESTRA_BENCHMARK_AGENT. Gateway fixture must contain coordinator-authenticated trio and provenance.agentId; harness does not mint attestations or fetch secrets. Select scenarios to fit request budget; full matrix requires explicit --max-requests override. No policy writes; deployment restored in finally. Node >=20.",
      );
      console.info(
        "Optional --codex-subscription requires --providers openai-responses and an explicit --openai-model. Secret process-memory environment: ARCHESTRA_BENCHMARK_CODEX_ACCESS_TOKEN, ARCHESTRA_BENCHMARK_CODEX_ACCOUNT_ID, ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY. Prefer codex-subscription-ab.mjs to load only the native auth file in memory. Coordinator configures task ARCHESTRA_OPENAI_CODEX_API_BASE_URL; capture-base only locates evidence in this lane. No refresh or official CLI episode behavior.",
      );
      console.info(
        "Optional --cache-routing-key sets OpenAI prompt_cache_key to the arm-isolated session namespace. Reports record this explicitly; default traffic without affinity remains a separate control.",
      );
    } else if (options.list || !options.live)
      console.info(
        JSON.stringify(
          {
            runId: options.runId,
            seed: options.seed,
            scenarios: options.scenarios,
            deferred: DEFERRED,
            providers: options.providers,
            requests: options.providers.flatMap((provider) =>
              options.scenarios
                .filter((s) => !s.providers || s.providers.includes(provider))
                .map((scenario) => ({
                  provider,
                  scenario: scenario.id,
                  body: options["dry-run"]
                    ? buildBody({
                        provider,
                        scenario,
                        model:
                          options.models[
                            provider === "anthropic" ? "anthropic" : "openai"
                          ] ?? "MODEL_REQUIRED",
                        session: sessionId({
                          runId: options.runId,
                          seed: options.seed,
                          provider,
                          scenario: scenario.id,
                          block: 0,
                          arm: "off",
                        }),
                        prefixWords: options.prefixWords,
                        maxTokens: options.maxTokens,
                        cacheRoutingKey: options["cache-routing-key"],
                      })
                    : undefined,
                })),
            ),
          },
          null,
          2,
        ),
      );
    else {
      const { out, summary } = await runLive(options);
      console.info(
        JSON.stringify({
          out,
          requests: summary.actualRequests,
          failure: summary.failure,
          cells: summary.cells.length,
          inconclusive: summary.cells.filter((c) => c.inconclusive).length,
        }),
      );
      if (summary.failure || summary.cells.some((c) => c.inconclusive))
        process.exitCode = 2;
    }
  } catch {
    console.error(
      "Benchmark refused or failed. Check --help, isolated-dev acknowledgement, loopback URLs, environment and request budget. No credential values are logged.",
    );
    process.exitCode = 1;
  }
}
