import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/**
 * Private equality projection, not authorization. Evidence must be captured from
 * actual provider/proxy/gateway boundaries, never reconstructed from actualBody.
 * projectedBody contains private history and must not enter public event logs.
 * records: [{providerCall, clientCall, gatewayResult}] with protocol-native calls.
 * runtime: {kind: 'appa-post-process-proxy-results', requestSha256,
 * recordedDecisions: [{callId, decision}], approvedResults:
 * [{callId, content, outputSource, code?}]}. Digest is SHA256(JSON.stringify(body))
 * before projection. Runtime data must be an independently captured session-owned
 * checkpoint, not inferred from the gateway echo or provider-bound body.
 */
export function projectRemedyHistory({ body, family, arm, client, evidence }) {
  const normalizations = [];
  const missingEvidence = [];
  const diagnostics = {
    noticeRestorations: 0,
    executionRestorations: 0,
    runtimeResultUpdates: 0,
    continuationRequired: null,
    missingEvidence,
  };
  const fail = (reason, needed) => {
    if (needed) missingEvidence.push({ kind: needed, source: SOURCE.runtime });
    return {
      supported: false,
      reason,
      normalizations,
      diagnostics,
      sourceCitations: { ...SOURCE },
    };
  };
  try {
    if (!["openai:responses", "anthropic:messages"].includes(family))
      return fail("unsupported_remedy_family");
    const projected = structuredClone(body);
    const sites = historySites(projected, family);
    if (
      sites.calls.some(
        (call) =>
          call.name === ASK ||
          /^(?:functions\.)?(?:spawn_agent|wait_agent|request_user_input|Agent)$/.test(
            call.name,
          ),
      )
    )
      return fail("unsupported_question_or_delegation_remedy_mix");
    const allCallIds = sites.calls.map((call) => rawId(call.id));
    if (
      allCallIds.some((id) => !id) ||
      new Set(allCallIds).size !== allCallIds.length
    )
      return fail("ambiguous_historical_call_ids");
    const helpers = sites.calls.filter((call) =>
      [NOTICE, EXECUTE].includes(call.name),
    );
    if (!helpers.length)
      return {
        supported: true,
        projectedBody: projected,
        normalizations,
        diagnostics: { ...diagnostics, continuationRequired: false },
        sourceCitations: { ...SOURCE },
      };
    if (arm !== "on") return fail("unsupported_cross_arm_remedy_history");
    if (helpers.some((call) => call.namespace !== undefined))
      return fail("unsupported_namespaced_remedy_history");
    if (!Array.isArray(evidence?.records) || evidence.records.length > 4096)
      return fail(
        "missing_authentic_remedy_roundtrips",
        "provider_original_proxy_released_gateway_result",
      );
    const declared = declaredNames(body, family);
    if (!declared.has(NOTICE) || !declared.has(EXECUTE))
      return fail("remedy_bindings_not_declared");
    const records = evidence.records.map((entry) => ({
      entry,
      client: capturedCall(entry.clientCall, family),
      original: capturedCall(entry.providerCall, family),
    }));
    const identifiers = records.map((entry) => rawId(entry.client?.id));
    if (
      identifiers.some((id) => !id) ||
      new Set(identifiers).size !== identifiers.length
    )
      return fail("ambiguous_remedy_witness_ids");
    const seen = new Set();
    const noticeIds = new Set();
    const change = (name, source) => {
      const existing = normalizations.find((entry) => entry.name === name);
      if (existing) existing.count++;
      else normalizations.push({ name, source, count: 1 });
    };
    for (const call of helpers) {
      const id = rawId(call.id);
      if (seen.has(id)) return fail("duplicate_historical_helper_id");
      seen.add(id);
      const witness = records.find((entry) => rawId(entry.client?.id) === id);
      const result = sites.results.filter((entry) => rawId(entry.id) === id);
      if (
        !witness?.original ||
        !witness.client ||
        !sameCall(call, witness.client, family) ||
        rawId(witness.original.id) !== id ||
        result.length !== 1 ||
        typeof result[0].text !== "string"
      )
        return fail(
          "missing_or_changed_original_history",
          "matching_original_released_call_and_single_result",
        );
      if (result[0].text !== JSON.stringify(witness.entry.gatewayResult))
        return fail("gateway_result_witness_mismatch");
      const args = objectArgs(call.arguments);
      if (!args) return fail("invalid_helper_arguments");
      if (call.name === NOTICE) {
        const notice = args.notice;
        const original = witness.original;
        if (
          Object.keys(args).some(
            (key) =>
              !["tool", "arguments", "ruling", "notice", "offers"].includes(
                key,
              ),
          ) ||
          !record(notice) ||
          Object.keys(notice).some(
            (key) => !["v", "call_id", "namespace"].includes(key),
          ) ||
          notice.v !== 1 ||
          notice.call_id !== id ||
          notice.custom !== undefined ||
          typeof args.ruling !== "string" ||
          !args.ruling ||
          args.tool !== original.name ||
          notice.namespace !== original.namespace ||
          original.namespace !== undefined ||
          !declared.has(original.name) ||
          [NOTICE, EXECUTE, ASK].includes(original.name) ||
          !objectArgs(args.arguments) ||
          !sameArguments(args.arguments, original.arguments, family)
        )
          return fail("notice_original_call_binding_failed");
        if (
          !record(witness.entry.gatewayResult) ||
          witness.entry.gatewayResult.isError === true ||
          !Array.isArray(witness.entry.gatewayResult.content) ||
          witness.entry.gatewayResult.content.length !== 1 ||
          witness.entry.gatewayResult.content[0]?.type !== "text" ||
          witness.entry.gatewayResult.content[0].text !== args.ruling
        )
          return fail("notice_gateway_echo_not_verified");
        call.restore(original.name, args.arguments, original.namespace);
        result[0].write(args.ruling, true);
        noticeIds.add(id);
        diagnostics.noticeRestorations++;
        change(
          "witnessed_notice_original_call_and_ruling_restoration",
          SOURCE.notice,
        );
      } else {
        const receipt = args.execution;
        const original = witness.original;
        const originalArgs = objectArgs(original.arguments);
        const receiptArgs = objectArgs(receipt?.original_arguments);
        if (
          original.name !== EXECUTE ||
          original.namespace !== call.namespace ||
          !record(receipt) ||
          Object.keys(receipt).some(
            (key) =>
              ![
                "v",
                "kind",
                "call_id",
                "tool_name",
                "namespace",
                "original_arguments",
              ].includes(key),
          ) ||
          receipt.v !== 1 ||
          receipt.kind !== "appa_remedy" ||
          receipt.call_id !== id ||
          receipt.tool_name !== call.name ||
          receipt.namespace !== call.namespace ||
          !originalArgs ||
          !receiptArgs ||
          !isDeepStrictEqual(withoutProxy(args), withoutProxy(receiptArgs)) ||
          !isDeepStrictEqual(
            withoutProxy(originalArgs),
            withoutProxy(receiptArgs),
          )
        )
          return fail("execution_original_arguments_binding_failed");
        const clean = withoutProxy(receiptArgs);
        const sourceRaw =
          typeof original.arguments === "string"
            ? original.arguments
            : JSON.stringify(originalArgs);
        const expectedRaw =
          Object.keys(withoutProxy(originalArgs)).length ===
          Object.keys(originalArgs).length
            ? sourceRaw
            : JSON.stringify(withoutProxy(originalArgs));
        if (
          family === "openai:responses" &&
          receipt.original_arguments !== expectedRaw
        )
          return fail("execution_original_argument_bytes_changed");
        const raw =
          Object.keys(clean).length === Object.keys(receiptArgs).length
            ? receipt.original_arguments
            : JSON.stringify(clean);
        call.restore(
          EXECUTE,
          family === "openai:responses" ? raw : clean,
          call.namespace,
        );
        diagnostics.executionRestorations++;
        change(
          "witnessed_execution_original_argument_restoration",
          SOURCE.execution,
        );
      }
    }
    // A later authentic control result suppresses continuation independently of
    // whether an older notice still has a recorded offer (plugin 4994-5024).
    const lastNoticeResult = sites.results.findLastIndex((entry) =>
      noticeIds.has(rawId(entry.id)),
    );
    const laterControl = sites.results
      .slice(lastNoticeResult + 1)
      .some((entry) =>
        sites.calls.some(
          (call) => rawId(call.id) === rawId(entry.id) && call.name === EXECUTE,
        ),
      );
    const checkpoint = evidence.runtime;
    const checkpointValid =
      checkpoint?.kind === "appa-post-process-proxy-results" &&
      checkpoint.requestSha256 === sha(body) &&
      Array.isArray(checkpoint.recordedDecisions) &&
      Array.isArray(checkpoint.approvedResults);
    if (checkpoint && !checkpointValid)
      return fail("runtime_checkpoint_not_bound_to_request");
    if (
      checkpointValid &&
      (!uniqueMap(checkpoint.recordedDecisions) ||
        !uniqueMap(checkpoint.approvedResults))
    )
      return fail("ambiguous_runtime_checkpoint");
    let continuation = false;
    if (lastNoticeResult >= 0 && !laterControl) {
      if (!checkpointValid)
        return fail(
          "runtime_continuation_state_not_observed",
          "request_bound_session_owned_runtime_decisions_and_approved_results",
        );
      const decisions = uniqueMap(checkpoint.recordedDecisions);
      const updates = uniqueMap(checkpoint.approvedResults);
      if (!decisions || !updates) return fail("ambiguous_runtime_checkpoint");
      let latestBlocked = -1;
      for (let index = 0; index < sites.results.length; index++) {
        const result = sites.results[index];
        const id = rawId(result.id);
        if (!decisions.has(id)) continue;
        const decision = decisions.get(id);
        const offered =
          decision.decision === "deny_call" &&
          typeof decision.feedback === "string" &&
          Array.isArray(decision.offers) &&
          decision.offers.some(
            (offer) =>
              record(offer) &&
              typeof offer.offer_id === "string" &&
              offer.offer_id.length > 0,
          )
            ? decision.feedback
            : undefined;
        const approved =
          updates.get(id) ??
          (offered !== undefined
            ? { content: offered, outputSource: "runtime" }
            : undefined);
        if (
          approved?.outputSource !== "runtime" ||
          approved.code === "unreleased_call" ||
          typeof approved.content !== "string"
        )
          continue;
        if (
          offered === undefined &&
          !["[appa] Blocked", "execute_remedy_plan", "offer_id"].every((text) =>
            approved.content.includes(text),
          )
        )
          continue;
        if (!noticeIds.has(id)) return fail("unmodeled_runtime_blocked_result");
        latestBlocked = index;
        if (approved.content !== result.text) {
          result.write(approved.content);
          diagnostics.runtimeResultUpdates++;
          change(
            "checkpoint_bound_runtime_notice_result_update",
            SOURCE.runtime,
          );
        }
      }
      continuation =
        latestBlocked >= 0 &&
        !sites.results
          .slice(latestBlocked + 1)
          .some((entry) =>
            sites.calls.some(
              (call) =>
                rawId(call.id) === rawId(entry.id) && call.name === EXECUTE,
            ),
          );
    }
    if (checkpointValid) {
      const updates = uniqueMap(checkpoint.approvedResults);
      if (!updates) return fail("ambiguous_runtime_checkpoint");
      for (const result of sites.results) {
        const update = updates.get(rawId(result.id));
        if (!update || update.content === result.text) continue;
        if (
          !seen.has(rawId(result.id)) ||
          update.outputSource !== "runtime" ||
          update.code === "unreleased_call" ||
          typeof update.content !== "string"
        )
          return fail("unmodeled_runtime_result_update");
        result.write(update.content);
        diagnostics.runtimeResultUpdates++;
        change("checkpoint_bound_runtime_helper_result_update", SOURCE.runtime);
      }
    }
    if (continuation) {
      if (family === "openai:responses") {
        if (client !== "codex")
          return fail(
            "codex_client_context_required_for_tool_choice_projection",
          );
        projected.input.push({
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: CONTINUATION }],
        });
        projected.tool_choice = "required";
        projected.parallel_tool_calls = false;
      } else {
        if (!Array.isArray(projected.system))
          return fail("unsupported_anthropic_system_shape");
        if (
          !projected.system.some(
            (block) => block.type === "text" && block.text === CONTINUATION,
          )
        )
          projected.system.push({ type: "text", text: CONTINUATION });
      }
      change(
        "runtime_bound_exact_remedy_offer_continuation",
        SOURCE.continuation,
      );
    }
    diagnostics.continuationRequired = continuation;
    return {
      supported: true,
      projectedBody: projected,
      normalizations,
      diagnostics,
      sourceCitations: { ...SOURCE },
    };
  } catch {
    return fail("unsupported_remedy_evidence_shape");
  }
}

const NOTICE = "archestra__get_remedy_plans";
const EXECUTE = "archestra__execute_remedy_plan";
const ASK = "archestra__ask_user";
const PROXY = new Set([
  "execution",
  "trajectory",
  "protected",
  "payload",
  "signature",
]);
const CONTINUATION =
  "The ruling above offers a remedy plan for the blocked call. If the plan fits the user's request, continue the task and apply the plan with execute_remedy_plan. Use the offer_id and plan from the ruling. execute_remedy_plan asks the user for approval when the policy requires it.";
const SOURCE = {
  notice:
    "backend/src/openappa/notice.ts:157-182; backend/src/openappa/wire.ts:101-137,1115-1182,1224-1260",
  execution:
    "backend/src/openappa/notice.ts:185-241; backend/src/openappa/wire.ts:146-176; backend/src/proxy/plugins/appa-plugin-archestra/plugin.ts:4061-4106",
  runtime:
    "backend/src/proxy/plugins/appa-plugin-archestra/plugin.ts:4931-5024; backend/src/models/openappa-session.ts:260-301",
  continuation:
    "backend/src/proxy/plugins/appa-plugin-archestra/plugin.ts:648-656,4287-4292,5274-5354,5378-5394",
};
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function objectArgs(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function withoutProxy(args) {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !PROXY.has(key)),
  );
}
function sha(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
function rawId(value) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("appat1") || value.length <= 28) return value;
  const payload = value.slice(6, -22);
  if (
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]{22}$/.test(value.slice(-22))
  )
    return value;
  const text = Buffer.from(payload, "base64url").toString("utf8");
  const at = text.indexOf("\u0000");
  return at > 0 &&
    at < text.length - 1 &&
    Buffer.from(text).toString("base64url") === payload
    ? text.slice(at + 1)
    : value;
}
function capturedCall(node, family) {
  if (!record(node)) return null;
  if (
    family === "openai:responses" &&
    node.type === "function_call" &&
    typeof node.call_id === "string" &&
    typeof node.name === "string"
  )
    return {
      node,
      id: node.call_id,
      name: node.name,
      namespace: node.namespace || undefined,
      arguments: node.arguments,
    };
  if (
    family === "anthropic:messages" &&
    node.type === "tool_use" &&
    typeof node.id === "string" &&
    typeof node.name === "string"
  )
    return {
      node,
      id: node.id,
      name: node.name,
      namespace: undefined,
      arguments: node.input,
    };
  return null;
}
function sameArguments(a, b, family) {
  return family === "openai:responses"
    ? typeof a === "string" && a === b
    : isDeepStrictEqual(objectArgs(a), objectArgs(b));
}
function sameCall(a, b, family) {
  return (
    a.name === b.name &&
    a.namespace === b.namespace &&
    rawId(a.id) === rawId(b.id) &&
    sameArguments(a.arguments, b.arguments, family)
  );
}
function historySites(body, family) {
  const calls = [];
  const results = [];
  const blocks =
    family === "openai:responses"
      ? body.input
      : body.messages?.flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        );
  if (!Array.isArray(blocks)) throw new Error("history_required");
  for (const node of blocks) {
    const call = capturedCall(node, family);
    if (call)
      calls.push({
        ...call,
        restore(name, args, namespace) {
          node.name = name;
          if (family === "openai:responses") {
            node.call_id = rawId(node.call_id);
            node.arguments =
              typeof args === "string" ? args : JSON.stringify(args);
            if (namespace) node.namespace = namespace;
            else delete node.namespace;
          } else {
            node.id = rawId(node.id);
            node.input = typeof args === "string" ? JSON.parse(args) : args;
          }
          this.name = name;
        },
      });
    if (
      (family === "openai:responses" &&
        node?.type === "function_call_output") ||
      (family === "anthropic:messages" && node?.type === "tool_result")
    ) {
      const key = family === "openai:responses" ? "output" : "content";
      results.push({
        id: family === "openai:responses" ? node.call_id : node.tool_use_id,
        text: node[key],
        write(text, denied) {
          node[key] = text;
          if (family === "openai:responses") node.call_id = rawId(node.call_id);
          else {
            node.tool_use_id = rawId(node.tool_use_id);
            if (denied) node.is_error = true;
          }
          this.text = text;
        },
      });
    }
  }
  return { calls, results };
}
function declaredNames(body, family) {
  const tools =
    family === "anthropic:messages"
      ? body.tools
      : [
          ...(body.tools ?? []),
          ...body.input
            .filter((item) => item.type === "additional_tools")
            .flatMap((item) => item.tools ?? []),
        ];
  return new Set(tools.map((tool) => tool.name));
}
function uniqueMap(records) {
  const out = new Map();
  for (const entry of records) {
    if (typeof entry.callId !== "string" || out.has(entry.callId)) return null;
    out.set(entry.callId, entry.decision ?? entry);
  }
  return out;
}
