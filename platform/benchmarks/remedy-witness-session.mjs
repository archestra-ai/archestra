import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withoutTrajectoryStamp } from "../backend/src/openappa/trajectory-stamp.ts";
import { createPrivateRemedyWitness } from "./private-remedy-witness.mjs";

// Call witnesses from original provider events, not a reconstructed model response.
export function decodeOriginalResponsesWitness(bytes) {
  const check = (valid) => {
    if (!valid) throw new Error("original_sse_call_witness_invalid");
  };
  const text = (value) => typeof value === "string" && value.length > 0;
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const argumentsValid = (value) =>
    typeof value === "string" && object(JSON.parse(value));
  const identity = ["type", "id", "call_id", "name", "namespace"];
  const same = ({ before, after, partial = false }) =>
    identity.every(
      (key) =>
        (partial && before[key] === undefined) ||
        isDeepStrictEqual(before[key], after[key]),
    );
  const callValid = (item) =>
    text(item.id) &&
    text(item.call_id) &&
    text(item.name) &&
    (item.namespace === undefined || typeof item.namespace === "string") &&
    (item.status == null || item.status === "completed") &&
    argumentsValid(item.arguments);
  try {
    check(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES);
    const frames = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .split(/\r?\n\r?\n/);
    const tail = frames.pop();
    check(
      !tail.trim() ||
        tail
          .split(/\r?\n/)
          .every((line) => !line.trim() || line.startsWith(":")),
    );
    const items = new Map();
    const indices = new Map();
    let terminal;
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const names = lines
        .filter((line) => line.startsWith("event:"))
        .map((line) => line.slice(6).trim());
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        check(terminal);
        continue;
      }
      const event = JSON.parse(data);
      check(
        object(event) &&
          typeof event.type === "string" &&
          names.length <= 1 &&
          (!names.length || names[0] === event.type),
      );
      if (event.type === "ping") continue;
      check(
        !terminal &&
          !["error", "response.failed", "response.incomplete"].includes(
            event.type,
          ),
      );
      if (event.type === "response.completed") {
        check(
          event.response?.status === "completed" &&
            Array.isArray(event.response.output) &&
            event.response.error == null &&
            event.response.incomplete_details == null,
        );
        terminal = event.response;
      } else if (
        ["response.output_item.added", "response.output_item.done"].includes(
          event.type,
        )
      ) {
        const item = event.item;
        const index = event.output_index;
        check(
          object(item) &&
            text(item.id) &&
            text(item.type) &&
            Number.isSafeInteger(index) &&
            index >= 0,
        );
        let state = items.get(item.id);
        check(
          (!indices.has(index) || indices.get(index) === item.id) &&
            (!state || state.index === index),
        );
        if (!state) {
          state = { index, deltas: [] };
          items.set(item.id, state);
          indices.set(index, item.id);
        }
        if (event.type === "response.output_item.added") {
          check(!state.added && !state.done);
          state.added = item;
        } else {
          check(
            !state.done &&
              (!state.added ||
                same({ before: state.added, after: item, partial: true })),
          );
          state.done = item;
        }
      } else if (
        [
          "response.function_call_arguments.delta",
          "response.function_call_arguments.done",
        ].includes(event.type)
      ) {
        const state = items.get(indices.get(event.output_index));
        check(
          state?.added?.type === "function_call" &&
            !state.done &&
            !state.argumentsDone &&
            (event.item_id === undefined || event.item_id === state.added.id),
        );
        for (const key of ["call_id", "name", "namespace"])
          if (event[key] !== undefined) check(event[key] === state.added[key]);
        if (event.type.endsWith(".delta")) {
          check(typeof event.delta === "string");
          state.deltas.push(event.delta);
        } else {
          check(argumentsValid(event.arguments));
          state.argumentsDone = event;
        }
      }
    }
    check(terminal);
    const terminalIds = new Map();
    const callIds = new Map();
    for (const item of terminal.output) {
      check(object(item) && text(item.id) && !terminalIds.has(item.id));
      terminalIds.set(item.id, item);
      if (item.type === "function_call") {
        check(callValid(item) && !callIds.has(item.call_id));
        callIds.set(item.call_id, item.id);
      }
    }
    const output = [...terminal.output];
    const callSources = {
      "original-sse-output-item-done": 0,
      "terminal-output": 0,
    };
    for (const [id, state] of items) {
      const final = terminalIds.get(id);
      const item = state.done ?? final;
      check(
        item &&
          (!state.added ||
            same({ before: state.added, after: item, partial: true })),
      );
      if (state.done && final)
        check(
          same({ before: state.done, after: final }) &&
            (item.type !== "function_call" ||
              item.arguments === final.arguments),
        );
      if (item.type === "function_call") {
        check(
          callValid(item) &&
            (!state.done || state.argumentsDone) &&
            (!state.argumentsDone ||
              state.argumentsDone.arguments === item.arguments),
        );
        const initial = state.added?.arguments ?? "";
        check(
          typeof initial === "string" && item.arguments.startsWith(initial),
        );
        if (state.deltas.length) {
          const delta = state.deltas.join("");
          check(delta === item.arguments || initial + delta === item.arguments);
        }
        check(!callIds.has(item.call_id) || callIds.get(item.call_id) === id);
        callIds.set(item.call_id, id);
      }
      if (!final) output.push(item);
    }
    for (const item of output)
      if (item.type === "function_call")
        callSources[
          items.get(item.id)?.done
            ? "original-sse-output-item-done"
            : "terminal-output"
        ]++;
    return { complete: true, output, callSources };
  } catch {
    return {
      complete: false,
      output: [],
      reason: "original_sse_call_witness_invalid",
    };
  }
}

export async function createRemedyWitnessSession({
  family,
  directory,
  providerDirectory,
  runtimeDirectory,
  loadRuntimeCheckpoint,
}) {
  if (!["openai:responses", "anthropic:messages"].includes(family))
    throw new Error("remedy_witness_family_invalid");
  let writer;
  let writerMissing = null;
  try {
    writer = await createPrivateRemedyWitness({ directory });
  } catch {
    writerMissing = "private_writer_unavailable";
  }
  let ordinal = 0;
  let gatewayOrdinal = 0;
  const requests = new Map();
  const pending = new Map();
  const completed = new Map();
  const gaps = new Map();
  const originalCallSources = {
    "original-sse-output-item-done": 0,
    "terminal-output": 0,
  };
  const fail = (key, code) => {
    gaps.set(key, code);
    return { supported: false, reason: code };
  };
  const requestSha = (body) => sha(Buffer.from(JSON.stringify(body)));
  const recordClientRequest = async ({ body }) => {
    const key = requestSha(body);
    if (requests.has(key)) return fail(key, "duplicate_client_request_digest");
    const current = { ordinal: ++ordinal, complete: false };
    requests.set(key, current);
    if (!writer) return fail(key, writerMissing);
    try {
      const saved = await writer.append({
        kind: "client_request",
        ordinal: current.ordinal,
        body,
      });
      if (saved.hash !== key)
        return fail(key, "client_request_witness_digest_mismatch");
      return { supported: true, requestSha256: key, ordinal: current.ordinal };
    } catch {
      return fail(key, "client_request_witness_unavailable");
    }
  };
  const recordModelRoundtrip = async ({
    clientBody,
    providerRecord,
    proxyOutput,
    decodeOriginalResponse,
  }) => {
    const key = requestSha(clientBody);
    const current = requests.get(key);
    if (current && writer)
      await recordProxyResponse({ clientBody, proxyOutput });
    if (!current || gaps.has(key))
      return fail(key, gaps.get(key) ?? "client_request_checkpoint_missing");
    try {
      const witness = providerRecord?.privateWitness;
      if (
        !witness?.privateWitnessRecorded ||
        !Number.isSafeInteger(providerRecord.idx) ||
        providerRecord.idx < 1
      )
        return fail(key, "provider_private_witness_missing");
      const base = String(providerRecord.idx).padStart(6, "0");
      const request = await privateFile(
        providerDirectory,
        `${base}-provider_request.json`,
      );
      const response = await privateFile(
        providerDirectory,
        `${base}-provider_response.sse`,
      );
      if (
        sha(request) !== witness.requestHash ||
        (providerRecord.requestHash &&
          sha(request) !== providerRecord.requestHash) ||
        sha(response) !== witness.responseHash ||
        !isDeepStrictEqual(JSON.parse(request), providerRecord.body)
      )
        return fail(key, "provider_private_witness_integrity_failed");
      const original = await decodeOriginalResponse(response);
      if (!original?.complete || !Array.isArray(original.output))
        return fail(key, "provider_original_response_incomplete");
      const before = calls(original.output, family);
      const after = calls(proxyOutput, family);
      const originalIds = before.map((call) => rawId(call, family));
      const clientIds = after.map((call) => rawId(call, family));
      if (
        originalIds.some((id) => !id) ||
        clientIds.some((id) => !id) ||
        new Set(originalIds).size !== originalIds.length ||
        new Set(clientIds).size !== clientIds.length
      )
        return fail(key, "ambiguous_original_or_proxy_call_ids");
      const pairs = [];
      for (const clientCall of after) {
        const id = rawId(clientCall, family);
        const matches = before.filter((call) => rawId(call, family) === id);
        const actual = actualId(clientCall, family);
        if (
          matches.length !== 1 ||
          pending.has(actual) ||
          completed.has(actual)
        )
          return fail(key, "original_proxy_call_not_uniquely_bound");
        pairs.push({
          actual,
          providerCall: structuredClone(matches[0]),
          clientCall: structuredClone(clientCall),
          sourceRequestSha256: key,
        });
      }
      // These are decoded actual proxy items, not reconstructed provider items.
      if (!current.proxySaved) {
        await writer.append({
          kind: "proxy_response",
          ordinal: current.ordinal,
          body: proxyOutput,
        });
        current.proxySaved = true;
      }
      for (const pair of pairs) pending.set(pair.actual, pair);
      current.complete = true;
      for (const source of Object.keys(originalCallSources))
        if (
          Number.isSafeInteger(original.callSources?.[source]) &&
          original.callSources[source] >= 0
        )
          originalCallSources[source] += original.callSources[source];
      return {
        supported: true,
        requestSha256: key,
        originalCalls: before.length,
        releasedCalls: after.length,
      };
    } catch {
      return fail(key, "provider_or_proxy_witness_unavailable");
    }
  };
  const recordProxyResponse = async ({ clientBody, proxyOutput }) => {
    const key = requestSha(clientBody);
    const current = requests.get(key);
    if (!current || !writer)
      return fail(key, "client_request_checkpoint_missing");
    if (current.proxySaved) return { supported: true };
    try {
      await writer.append({
        kind: "proxy_response",
        ordinal: current.ordinal,
        body: proxyOutput,
      });
      current.proxySaved = true;
      return { supported: true };
    } catch {
      return fail(key, "proxy_response_witness_unavailable");
    }
  };
  const observeGatewayRoundtrip = async ({ request, result }) => {
    const index = ++gatewayOrdinal;
    const key = `gateway:${index}`;
    try {
      if (
        !request ||
        Object.keys(request).some(
          (name) =>
            !["method", "params", "agent", "session", "jsonrpc", "id"].includes(
              name,
            ),
        ) ||
        request.method !== "tools/call" ||
        !request.params ||
        Object.keys(request.params).some(
          (name) => !["name", "arguments", "_meta"].includes(name),
        )
      )
        return fail(key, "gateway_body_envelope_invalid");
      const capturedRequest = {
        method: request.method,
        params: request.params,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        ...(request.session === undefined ? {} : { session: request.session }),
      };
      await writer.append({
        kind: "gateway_request",
        ordinal: index,
        body: capturedRequest,
      });
      await writer.append({
        kind: "gateway_response",
        ordinal: index,
        body: result,
      });
      const id = request.params._meta?.["com.archestra/logicalToolCallId"];
      const pair = typeof id === "string" ? pending.get(id) : null;
      if (!pair || completed.has(id))
        return fail(key, "gateway_proxy_call_id_not_bound");
      const expectedArgs =
        family === "openai:responses"
          ? JSON.parse(pair.clientCall.arguments)
          : pair.clientCall.input;
      if (
        request.params.name !== pair.clientCall.name ||
        !isDeepStrictEqual(request.params.arguments ?? {}, expectedArgs)
      )
        return fail(key, "gateway_proxy_arguments_changed");
      const record = {
        providerCall: pair.providerCall,
        clientCall: pair.clientCall,
        gatewayResult: structuredClone(result),
      };
      completed.set(id, record);
      pending.delete(id);
      return {
        supported: true,
        clientCallHash: objectSha(pair.clientCall),
        gatewayResultHash: objectSha(result),
      };
    } catch {
      return fail(key, "gateway_witness_unavailable");
    }
  };
  const resolve = async ({ clientBody }) => {
    const key = requestSha(clientBody);
    let runtime;
    let runtimeState = "loader_unavailable";
    const loader =
      loadRuntimeCheckpoint ??
      (runtimeDirectory
        ? async ({ requestSha256 }) => {
            try {
              await lstat(
                join(runtimeDirectory, `ambiguous-${requestSha256}.json`),
              );
              throw new Error("ambiguous_runtime_checkpoint");
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            return JSON.parse(
              await privateFile(
                runtimeDirectory,
                `checkpoint-${requestSha256}.json`,
              ),
            );
          }
        : null);
    if (typeof loader === "function") {
      try {
        runtime = await loader({ requestSha256: key, runtimeDirectory });
        runtimeState =
          runtime == null
            ? "missing"
            : runtime?.kind === "appa-post-process-proxy-results" &&
                runtime.requestSha256 === key &&
                Array.isArray(runtime.recordedDecisions) &&
                Array.isArray(runtime.approvedResults)
              ? "request_bound"
              : "mismatched";
      } catch (error) {
        runtimeState =
          error?.message === "ambiguous_runtime_checkpoint"
            ? "ambiguous"
            : "unavailable";
      }
    }
    const current = requests.get(key);
    const reason =
      writerMissing ??
      gaps.values().next().value ??
      (runtimeState === "mismatched"
        ? "runtime_checkpoint_not_bound_to_request"
        : runtimeState === "ambiguous"
          ? "ambiguous_runtime_checkpoint"
          : null) ??
      (!current?.complete ? "current_provider_witness_not_complete" : null);
    const response = {
      supported: !reason,
      diagnostic: {
        reason,
        requestSha256: key,
        completedRoundtrips: completed.size,
        pendingProxyCalls: pending.size,
        runtimeCheckpoint: runtimeState,
        missingEvidence: [...new Set(gaps.values())],
        stampSignatureVerified: false,
        idSource: "backend/src/openappa/trajectory-stamp.ts:65-68",
        providerSource: "private-original-upstream-response-fence",
        originalCallSources: { ...originalCallSources },
      },
    };
    // Private witnesses must never be copied into public row/event evidence.
    Object.defineProperty(response, "evidence", {
      enumerable: false,
      value: {
        records: [...completed.values()].map((value) => structuredClone(value)),
        ...(runtime == null ? {} : { runtime: structuredClone(runtime) }),
      },
    });
    return response;
  };
  return {
    recordClientRequest,
    recordProxyResponse,
    recordModelRoundtrip,
    observeGatewayRoundtrip,
    resolve,
    close: async () => {
      await writer?.close();
      pending.clear();
      completed.clear();
      requests.clear();
      gaps.clear();
    },
  };
}

async function privateFile(directory, name) {
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new Error("private_directory_invalid");
  let current = parse(directory).root;
  for (const part of relative(current, directory)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("private_directory_invalid");
  }
  const root = await lstat(directory);
  if (
    (root.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && root.uid !== process.getuid())
  )
    throw new Error("private_directory_permissions");
  const file = join(directory, name);
  if (dirname(file) !== directory) throw new Error("private_file_invalid");
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_BYTES ||
    (info.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new Error("private_file_invalid");
  return readFile(file);
}
function calls(output, family) {
  return (output ?? []).filter((item) =>
    family === "openai:responses"
      ? item?.type === "function_call"
      : item?.type === "tool_use",
  );
}
function actualId(call, family) {
  return family === "openai:responses" ? call.call_id : call.id;
}
function rawId(call, family) {
  const id = actualId(call, family);
  return typeof id === "string" && id ? withoutTrajectoryStamp(id) : null;
}
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
function objectSha(value) {
  return sha(Buffer.from(JSON.stringify(value)));
}
const MAX_BYTES = 4 * 1024 * 1024;
