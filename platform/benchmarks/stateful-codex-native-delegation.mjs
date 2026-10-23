import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeUsage } from "./live-ab.mjs";
import { buildClientLaunch } from "./native-client.mjs";
import { projectResultError } from "./project-error-classification.mjs";
import { prepareStatefulCodexDirectCatalog } from "./stateful-codex-direct-catalog.mjs";

export async function runStatefulCodexNativeDelegation({
  proxyBase,
  captureBase,
  agent,
  gatewayToken,
  passthroughKey,
  fixtureNames,
  nativeFixtureNames,
  helperNames,
  namespace,
  mode = "pilot",
  arm = "on",
  prefixText = "",
  rawHistoryPath,
  emit = async () => {},
  inventoryOnly = false,
  env = process.env,
  runNative,
  prepareCatalog = prepareStatefulCodexDirectCatalog,
  timeoutMs = 20 * 60 * 1000,
  workload = null,
  measurements = null,
  signal: externalSignal,
}) {
  const projectMode = workload !== null;
  assert.ok(
    workload?.protocol === undefined || workload?.protocol === "project",
    "native_workload_protocol_unknown",
  );
  runNative ??= nativeProcess;
  assert.ok(
    !projectMode ||
      (typeof workload.prompt === "string" &&
        workload.prompt.length > 0 &&
        typeof workload.isComplete === "function" &&
        typeof workload.allowCall === "function" &&
        typeof workload.requireChild === "boolean"),
  );
  for (const value of [proxyBase, captureBase])
    if (value !== undefined) {
      const url = new URL(value);
      assert.ok(
        url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/",
        "loopback_origins_required",
      );
    }
  assert.ok(
    proxyBase &&
      gatewayToken &&
      passthroughKey &&
      typeof agent === "string" &&
      /^[a-z0-9-]+$/i.exec(agent)?.[0] === agent,
  );
  assert.ok(
    typeof namespace === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.exec(namespace)?.[0] === namespace,
  );
  assert.ok(
    ["pilot", "full"].includes(mode) &&
      ["on", "off"].includes(arm) &&
      Number.isInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 1200000,
  );
  assert.ok(
    Array.isArray(fixtureNames) &&
      fixtureNames.length ===
        (projectMode ? 6 : 128) &&
      new Set(fixtureNames).size === fixtureNames.length,
  );
  assert.ok(
    Array.isArray(helperNames) &&
      new Set(helperNames).size === helperNames.length,
  );
  const allNames = [...fixtureNames, ...helperNames];
  const collisionGuard = new Map();
  for (const name of allNames) {
    // Conservative rejection only, NEVER an identity-resolution/sanitizer rule.
    const key = name.replaceAll("-", "_");
    assert.ok(
      !collisionGuard.has(key) || collisionGuard.get(key) === name,
      "native_gateway_name_collision",
    );
    collisionGuard.set(key, name);
  }
  const promptFixtureNames = nativeFixtureNames ?? fixtureNames;
  assert.ok(
    Array.isArray(promptFixtureNames) &&
      promptFixtureNames.length === fixtureNames.length &&
      new Set(promptFixtureNames).size === fixtureNames.length &&
      promptFixtureNames.every(
        (name) =>
          typeof name === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.exec(name)?.[0] === name,
      ),
    "native_gateway_name_collision",
  );
  assert.ok(
    new Set(allNames).size === allNames.length &&
      allNames.every(
        (name) =>
          typeof name === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.exec(name)?.[0] === name,
      ),
  );
  assert.equal(typeof prefixText, "string");
  const goal = mode === "pilot" ? 2 : 100;
  const spawnAfter = mode === "pilot" ? 2 : 40;
  const longProject = projectMode && workload.longWorkload === true;
  const maxParent = projectMode
    ? longProject
      ? 120
      : 40
    : mode === "pilot"
      ? 10
      : 200;
  const maxTotal = projectMode
    ? longProject
      ? 200
      : 100
    : mode === "pilot"
      ? 20
      : 200;
  const model = env.ARCHESTRA_BENCHMARK_CODEX_MODEL ?? "gpt-6.1-sol";
  assert.match(model, /^(?:gpt|codex|chatgpt)-[a-zA-Z0-9_.-]+$/, "native_delegation_model_invalid");
  const scope = { parent: null, child: null };
  const stats = {
    parent: {
      modelRequests: 0,
      confirmedResponses: 0,
      fixtures: 0,
      helpers: 0,
      usage: [],
    },
    child: {
      modelRequests: 0,
      confirmedResponses: 0,
      fixtures: 0,
      helpers: 0,
      usage: [],
    },
    totalModelRequests: 0,
    spawnCalls: 0,
    waitCalls: 0,
    spawnAckObserved: false,
    terminalReturnObserved: false,
    terminalReturnAdmitted: false,
    catalogToolsSeen: 0,
    waitResultsObserved: 0,
    refusedRequests: 0,
    ambiguousDispatches: 0,
  };
  const controller = new AbortController();
  const dispatcher = new Agent();
  const sockets = new Set();
  const handlers = new Set();
  const busy = new Set();
  const issued = new Map();
  const authenticatedGatewayTools = new Map();
  let initialNameBindings = [];
  const seenWaitResults = new Set();
  const observedModels = new Set();
  const observedServiceTiers = new Set();
  let spawnCall;
  let ack;
  let childValue;
  const returnEvidence = {
    captureRecordSeen: false,
    candidateCount: 0,
    exactValueMatched: false,
  };
  let catalog;
  let directory;
  let server;
  let transcript;
  let rawWrites = Promise.resolve();
  let native;
  let running;
  let stopReason;
  let evidenceIndex = 0;
  let terminateNative = () => {};
  let closed = false;
  const record = async (event) => {
    await emit({ mode, arm, ...event });
  };
  const raw = (entry) => {
    if (transcript)
      rawWrites = rawWrites.then(() =>
        transcript.appendFile(`${JSON.stringify(entry)}\n`),
      );
    return rawWrites;
  };
  const stop = (reason) => {
    stopReason ??= reason;
    controller.abort();
    terminateNative();
  };
  const interrupt = () => stop("interrupted");
  externalSignal?.addEventListener("abort", interrupt, { once: true });
  if (externalSignal?.aborted) interrupt();
  const timer = setTimeout(() => stop("native_delegation_timeout"), timeoutMs);
  for (const signal of SIGNALS) process.on(signal, interrupt);
  const modelPath = `/v1/openai/${agent}/responses`;
  const gatewayPath = `/v1/mcp/${agent}`;
  let failure;
  let lastFailure = null;
  let initialTaskInventory = null;
  let lastModelOutput = null;
  let providerRequestAttempts = 0;
  let cleanupFailure = false;
  let timingStarted = false;
  let timingFinished = false;

  // Only the ON arm admits a protected return. The OFF counterfactual is a
  // native-return control: the exact unchanged child bytes must still appear in
  // the provider-bound envelope, but that match is never a protected admission.
  const returnSatisfied = () =>
    arm === "on"
      ? stats.terminalReturnAdmitted
      : returnEvidence.exactValueMatched;
  const criteria = () =>
    projectMode
      ? workload.isComplete() === true &&
        (workload.requireChild
          ? stats.child.fixtures >= 3 &&
            stats.spawnCalls === 1 &&
            stats.spawnAckObserved &&
            stats.terminalReturnObserved &&
            returnSatisfied() &&
            !!scope.child
          : stats.spawnCalls === 0 && !scope.child)
      : stats.parent.fixtures === goal &&
        stats.child.fixtures === 1 &&
        stats.spawnCalls === 1 &&
        stats.waitResultsObserved > 0 &&
        stats.spawnAckObserved &&
        stats.terminalReturnObserved &&
        returnSatisfied() &&
        !!scope.child;
  async function bodyFetch(path, options) {
    return fetch(`${proxyBase.replace(/\/$/, "")}${path}`, {
      ...options,
      redirect: "error",
      dispatcher,
      signal: options?.signal ?? controller.signal,
    });
  }
  async function observeAdmission(body, identity, after) {
    if (
      !captureBase ||
      returnSatisfied() ||
      identity.role !== "parent" ||
      !stats.terminalReturnObserved ||
      childValue === undefined
    )
      return;
    for (
      let attempt = 0;
      attempt < 6 && !controller.signal.aborted;
      attempt++
    ) {
      const response = await fetch(
        `${captureBase.replace(/\/$/, "")}/evidence?sessionId=${encodeURIComponent(namespace)}&after=${after}`,
        { dispatcher, signal: controller.signal, redirect: "error" },
      );
      assert.ok(response.ok, "capture_unavailable");
      const evidence = JSON.parse(await readBytes(response.body));
      const match = (evidence.records ?? []).findLast(
        (row) =>
          row.idx > after &&
          row.body &&
          nativeIds(row.body, {}).root === identity.root,
      );
      if (match) {
        returnEvidence.captureRecordSeen = true;
        returnEvidence.cacheKeyMatched =
          match.body.prompt_cache_key === body.prompt_cache_key;
        evidenceIndex = Math.max(evidenceIndex, match.idx);
        // A display marker is not authority. The source's native return envelope
        // must survive the enforcing proxy with the EXACT retained child value.
        const candidates = completedValues(match.body.input, issued, ack);
        returnEvidence.candidateCount = candidates.length;
        returnEvidence.exactValueMatched = candidates.some(
          (value) => value === childValue,
        );
        if (!returnEvidence.exactValueMatched) return;
        if (arm === "off") {
          // enforcement=off: a byte-exact native return match is the control
          // observation, never a protected-return admission.
          await record({
            kind: "child_return_admission",
            admitted: false,
            enforcement: false,
            exactValueMatched: true,
            childValueHash: hash(childValue),
            providerBodyHash: hash(match.body),
            localSignatureVerification: false,
          });
          return;
        }
        if (evidence.mode === "live") {
          stats.terminalReturnAdmitted = true;
          await record({
            kind: "child_return_admission",
            admitted: true,
            childValueHash: hash(childValue),
            providerBodyHash: hash(match.body),
            localSignatureVerification: false,
          });
        }
        return;
      }
      await abortableDelay(50, controller.signal);
    }
  }
  function observeNativeInput(body) {
    if (!spawnCall) return;
    for (const item of body.input ?? []) {
      if (item.type !== "function_call_output") continue;
      if (
        issued.get(item.call_id)?.name === "wait_agent" &&
        !seenWaitResults.has(item.call_id)
      ) {
        try {
          const value = jsonObject(item.output);
          if (
            value &&
            !value.error &&
            value.isError !== true &&
            (typeof value.timed_out === "boolean" || object(value.status))
          ) {
            seenWaitResults.add(item.call_id);
            stats.waitResultsObserved++;
          }
        } catch {
          /* Unsupported native result remains unproven. */
        }
      }
      if (item.call_id === spawnCall) {
        let value;
        try {
          value =
            typeof item.output === "string"
              ? JSON.parse(item.output)
              : item.output;
        } catch {
          continue;
        }
        if (
          typeof value?.agent_id === "string" ||
          typeof value?.task_name === "string"
        ) {
          ack = { agentId: value.agent_id, taskName: value.task_name };
          stats.spawnAckObserved = true;
        }
      }
    }
    if (completedValues(body.input, issued, ack).length > 0)
      stats.terminalReturnObserved = true;
  }
  async function handle(req, res) {
    const requestStartedMs = performance.now();
    let measuredId;
    let measuredEnded = false;
    let measuredToolFailure = false;
    const finishMeasurement = (status) => {
      if (measuredId !== undefined && !measuredEnded) {
        measuredEnded = true;
        measurements.end({
          id: measuredId,
          status,
          httpStatus: res.statusCode,
        });
      }
    };
    res.once("finish", () =>
      finishMeasurement(
        res.statusCode >= 400 || measuredToolFailure ? "failed" : "complete",
      ),
    );
    res.once("close", () => finishMeasurement("cancelled"));
    let identity;
    let stage = "routing";
    try {
      assert.ok(
        !closed &&
          req.url.startsWith("/") &&
          !req.url.startsWith("//") &&
          req.url.length <= 2048 &&
          !/[\\#\r\n]/.test(req.url),
        "route_refused",
      );
      if (req.url === gatewayPath) {
        if (measurements)
          measuredId = measurements.begin({
            kind:
              req.method === "GET" &&
              /text\/event-stream/i.test(req.headers.accept ?? "")
                ? "mcp_stream"
                : "mcp_setup",
            startedMs: requestStartedMs,
          });
        stage = "gateway_discovery";
        assert.equal(
          req.headers.authorization,
          `Bearer ${gatewayToken}`,
          "gateway_auth_refused",
        );
        if (
          req.method === "GET" &&
          /text\/event-stream/i.test(req.headers.accept ?? "")
        ) {
          const streamController = new AbortController();
          const cancelStream = () => streamController.abort();
          res.once("close", cancelStream);
          try {
            const response = await bodyFetch(gatewayPath, {
              headers: headers(req.headers),
              signal: AbortSignal.any([
                controller.signal,
                streamController.signal,
              ]),
            });
            res.writeHead(
              response.status,
              headers(Object.fromEntries(response.headers)),
            );
            let count = 0;
            for await (const part of response.body ?? []) {
              count += part.length;
              assert.ok(count <= MAX_BYTES);
              if (!res.destroyed) res.write(part);
            }
            if (!res.destroyed) res.end();
          } catch (error) {
            // Native clients close their optional discovery streams on exit.
            // Keep that cancellation distinct from a live upstream failure.
            if (!res.destroyed) throw error;
            await record({
              kind: "native_gateway_lifecycle",
              method: "GET",
              status: "client_cancelled",
            });
          } finally {
            res.off("close", cancelStream);
          }
          return;
        }
        if (req.method === "DELETE") {
          const response = await bodyFetch(gatewayPath, {
            method: "DELETE",
            headers: headers(req.headers),
          });
          res.writeHead(
            response.status,
            headers(Object.fromEntries(response.headers)),
          );
          res.end(await readBytes(response.body));
          await record({
            kind: "native_gateway_lifecycle",
            method: "DELETE",
            status: response.status,
          });
          return;
        }
        assert.equal(req.method, "POST", "gateway_method_refused");
        const bytes = await readBytes(req);
        const rpc = JSON.parse(bytes);
        assert.ok(
          rpc &&
            !Array.isArray(rpc) &&
            [...DISCOVERY, "tools/call"].includes(rpc.method),
          "gateway_method_refused",
        );
        let source;
        if (rpc.method === "tools/call") {
          stage = "gateway_dispatch";
          assert.ok(
            allNames.includes(rpc.params?.name),
            "gateway_tool_refused",
          );
          const key = hash({
            name: rpc.params.name,
            arguments: rpc.params.arguments ?? {},
          });
          const matches = [...issued.values()].filter(
            (call) => call.key === key && !call.used,
          );
          if (matches.length !== 1) {
            stats.ambiguousDispatches++;
            throw new Error("unattributed_native_gateway_call");
          }
          source = matches[0];
          source.used = true;
          if (measurements)
            measurements.classify({
              id: measuredId,
              kind: "mcp_tool",
              role: source.role,
              operation: projectMode
                ? source.name.split("__").at(-1)
                : "fixture",
              requestHash: hash(rpc),
            });
        }
        const response = await bodyFetch(gatewayPath, {
          method: "POST",
          headers: headers(req.headers),
          body: bytes,
        });
        const data = await readBytes(response.body);
        const envelope = rpcResult(data, rpc.id);
        if (
          rpc.method === "tools/list" &&
          Array.isArray(envelope?.result?.tools)
        ) {
          const actual = new Set(
            envelope.result.tools.map((tool) => tool.name),
          );
          assert.equal(
            actual.size,
            envelope.result.tools.length,
            "native_gateway_name_collision",
          );
          for (const tool of envelope.result.tools)
            if (allNames.includes(tool.name))
              authenticatedGatewayTools.set(tool.name, tool);
          assert.ok(
            fixtureNames.every((name) => actual.has(name)) &&
              helperNames.every((name) => actual.has(name)),
            "actual_gateway_catalog_incomplete",
          );
          stats.catalogToolsSeen = Math.max(
            stats.catalogToolsSeen,
            actual.size,
          );
        }
        if (source) {
          const result = envelope?.result;
          const ok =
            response.ok &&
            !envelope.error &&
            result &&
            result.isError !== true &&
            (result.resultType === undefined ||
              result.resultType === "complete");
          const isFixture = fixtureNames.includes(source.name);
          measuredToolFailure = !ok;
          // Gateway names include the server prefix; the fixture itself receives
          // its original short name (stateful-mcp-fixture.mjs:40-59).
          const originalName = /(?:^|__)(fixture_\d{3})$/.exec(
            source.name,
          )?.[1];
          const expected = `STEP ${source.args.step}: SYNTHETIC-RECORD-${originalName ?? source.name}.`;
          const executed =
            !!ok &&
            (!isFixture ||
              projectMode ||
              (result.content ?? []).some(
                (part) => part.type === "text" && part.text.includes(expected),
              ));
          if (executed) {
            if (isFixture) stats[source.role].fixtures++;
            else stats[source.role].helpers++;
          }
          if (projectMode && typeof workload.onToolResult === "function")
            await workload.onToolResult({
              role: source.role,
              name: source.name,
              ok: executed,
              args: source.args,
              result,
            });
          await record({
            kind: "native_gateway_execution",
            role: source.role,
            nativeThreadHash: source.threadHash,
            callHash: hash(source.id),
            toolHash: hash(source.name),
            argumentsHash: hash(source.args),
            actualResultHash: hash(result ?? null),
            ok: executed,
            fixture: isFixture,
            scopeSource: "unique-actual-proxy-released-name-and-arguments",
          });
          const recoverableProjectError =
            projectMode &&
            isFixture &&
            response.ok &&
            !envelope.error &&
            projectResultError(result) === "request_validation";
          if (projectMode && isFixture && result?.isError === true)
            await record({
              kind: "native_project_tool_error",
              role: source.role,
              classification: recoverableProjectError
                ? "request_validation"
                : "harness",
              creditedExecution: false,
            });
          assert.ok(
            executed || !isFixture || recoverableProjectError,
            "actual_fixture_execution_unconfirmed",
          );
        }
        res.writeHead(
          response.status,
          headers(Object.fromEntries(response.headers)),
        );
        res.end(data);
        return;
      }
      assert.ok(
        req.url === modelPath && req.method === "POST",
        "route_refused",
      );
      assert.equal(
        req.headers["x-archestra-virtual-key"],
        passthroughKey,
        "virtual_key_refused",
      );
      assert.ok(
        !req.headers["x-appa-session-id"] &&
          !req.headers["x-appa-parent-id"] &&
          !req.headers["x-archestra-session-id"],
        "noncanonical_fixed_session_header",
      );
      assert.ok(
        /codex/i.test(req.headers["user-agent"] ?? ""),
        "native_user_agent_required",
      );
      stage = "native_identity";
      if (measurements)
        measuredId = measurements.begin({
          kind: "llm_client",
          startedMs: requestStartedMs,
        });
      const body = JSON.parse(await readBytes(req));
      const nativeIdentity = nativeIds(body, req.headers);
      assert.ok(
        nativeIdentity.root && !nativeIdentity.guardian,
        "native_identity_unavailable",
      );
      if (!scope.parent) {
        assert.ok(!nativeIdentity.parent, "first_thread_is_not_parent");
        scope.parent = nativeIdentity.root;
      }
      if (nativeIdentity.root === scope.parent)
        identity = { role: "parent", root: nativeIdentity.root };
      else {
        assert.ok(
          stats.spawnCalls === 1 && nativeIdentity.parent === scope.parent,
          "unrelated_native_session",
        );
        assert.ok(
          !scope.child || scope.child === nativeIdentity.root,
          "more_than_one_native_child",
        );
        scope.child = nativeIdentity.root;
        identity = { role: "child", root: nativeIdentity.root };
      }
      if (measurements)
        measurements.classify({
          id: measuredId,
          kind: "llm_client",
          role: identity.role,
          operation: null,
          requestHash: hash(body),
        });
      assert.ok(!busy.has(identity.root), "parallel_same_thread_request");
      busy.add(identity.root);
      assert.ok(
        stats.totalModelRequests < maxTotal &&
          (identity.role !== "parent" ||
            stats.parent.modelRequests < maxParent) &&
          (!projectMode ||
            identity.role !== "child" ||
            stats.child.modelRequests < (longProject ? 120 : 60)),
        "native_request_budget",
      );
      stats.totalModelRequests++;
      stats[identity.role].modelRequests++;
      assert.ok(
        stats.catalogToolsSeen >= fixtureNames.length &&
          Array.isArray(body.input),
        "native_bootstrap_or_discovery_incomplete",
      );
      assert.ok(
        modelMatches(body.model, model),
        "actual_model_response_unconfirmed",
      );
      observeNativeInput(body);
      stage = "inventory_observation";
      await raw({
        direction: "native_request",
        role: identity.role,
        nativeThreadHash: hash(identity.root),
        input: body.input,
        ...(typeof body.instructions === "string"
          ? { instructions: body.instructions }
          : {}),
        ...(body.tools === undefined ? {} : { tools: body.tools }),
        ...(body.additional_tools === undefined
          ? {}
          : { additional_tools: body.additional_tools }),
      });
      const nameBindings = bindObservedGatewayNames(
        body,
        authenticatedGatewayTools,
      );
      const before = inspectCodexNativeTaskInventory({
        body,
        fixtureNames,
        helperNames,
        nameBindings,
      });
      const initialInventory =
        identity.role === "parent" && !initialTaskInventory;
      if (initialInventory) {
        initialNameBindings = nameBindings;
        initialTaskInventory = { before, after: null };
        await record({
          kind: "initial_native_task_inventory_before_filter",
          inventory: before,
        });
      }
      stage = "declaration_filter";
      const allowed = filterDeclarations({
        body,
        role: projectMode && !workload.requireChild ? "worker" : identity.role,
        fixtures: fixtureNames,
        helpers: helperNames,
        nameBindings,
        allowChildProjectTools: projectMode,
      });
      const afterInventory = inspectCodexNativeTaskInventory({
        body,
        fixtureNames,
        helperNames,
        nameBindings,
      });
      if (initialInventory) {
        initialTaskInventory.after = afterInventory;
        await record({
          kind: "initial_native_task_inventory_after_filter",
          inventory: afterInventory,
        });
      }
      if (inventoryOnly) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end('{"error":{"type":"native_inventory_discovery_only"}}');
        stop("native_inventory_captured_no_inference");
        return;
      }
      assert.ok(
        afterInventory.canonicalFixtureCount >=
          (identity.role === "parent" ? fixtureNames.length : 1),
        "native_task_fixture_declarations_missing",
      );
      if (identity.role === "parent")
        assert.ok(
          fixtureNames.every((rawName, index) =>
            nameBindings.some(
              (binding) =>
                binding.gatewayName === rawName &&
                binding.nativeName === promptFixtureNames[index],
            ),
          ),
          "native_prompt_tool_mapping_required",
        );
      assert.ok(
        afterInventory.deferredFixtureCount === 0 ||
          afterInventory.toolSearchDeclarations.length > 0,
        "native_task_tools_deferred_without_search",
      );
      assert.ok(
        allowed.some((entry) => entry.namespace === MCP_NAMESPACE),
        "native_mcp_namespace_missing",
      );
      if (
        identity.role === "parent" &&
        stats.spawnCalls === 0 &&
        (!projectMode || workload.requireChild)
      )
        assert.ok(
          allowed.some(
            (entry) =>
              entry.name === "spawn_agent" &&
              NATIVE_NAMESPACES.has(entry.namespace),
          ) &&
            allowed.some(
              (entry) =>
                entry.name === "wait_agent" &&
                NATIVE_NAMESPACES.has(entry.namespace),
            ),
          "actual_native_delegation_schemas_missing",
        );
      let after = evidenceIndex;
      if (
        captureBase &&
        !returnSatisfied() &&
        identity.role === "parent" &&
        stats.terminalReturnObserved &&
        childValue !== undefined
      ) {
        // An empty records window returns the completion cursor without copying
        // retained request metadata, which can exceed the evidence-body bound.
        const cursorResponse = await fetch(
          `${captureBase.replace(/\/$/, "")}/records?after=${Number.MAX_SAFE_INTEGER}`,
          { dispatcher, signal: controller.signal, redirect: "error" },
        );
        assert.ok(cursorResponse.ok, "capture_unavailable");
        const cursor = JSON.parse(await readBytes(cursorResponse.body));
        assert.ok(
          Array.isArray(cursor.records) &&
            cursor.records.length === 0 &&
            Number.isSafeInteger(cursor.lastIdx) &&
            cursor.lastIdx >= after,
          "capture_cursor_invalid",
        );
        after = cursor.lastIdx;
      }
      stage = "provider_request";
      providerRequestAttempts++;
      const response = await bodyFetch(modelPath, {
        method: "POST",
        headers: headers(req.headers),
        body: JSON.stringify(body),
      });
      const data = await readBytes(response.body);
      stage = "model_output";
      if (!response.ok) {
        await record({
          kind: "native_model_response",
          role: identity.role,
          status: response.status,
          ok: false,
          errorBodyHash: hash(data.toString("utf8")),
        });
        res.writeHead(
          response.status,
          headers(Object.fromEntries(response.headers)),
        );
        res.end(data);
        stop("native_proxy_refusal");
        return;
      }
      const actual = completedResponse(data);
      assert.ok(
        actual?.status === "completed" &&
          Array.isArray(actual.output) &&
          modelMatches(actual.model, model),
        "actual_model_response_unconfirmed",
      );
      observedModels.add(actual.model);
      if (
        ["auto", "default", "flex", "priority", "scale"].includes(
          actual.service_tier,
        )
      )
        observedServiceTiers.add(actual.service_tier);
      stats[identity.role].confirmedResponses++;
      const usage = safeUsage(actual.usage);
      stats[identity.role].usage.push(usage);
      await raw({
        direction: "proxy_response",
        role: identity.role,
        nativeThreadHash: hash(identity.root),
        output: actual.output,
      });
      try {
        await observeAdmission(body, identity, after);
      } catch {
        await record({
          kind: "child_return_admission_unavailable",
          admitted: false,
        });
      }
      await record({
        kind: "native_model_response",
        role: identity.role,
        nativeThreadHash: hash(identity.root),
        parentNativeHash: nativeIdentity.parent
          ? hash(nativeIdentity.parent)
          : null,
        status: response.status,
        ok: true,
        model: actual.model,
        responseMessageHash:
          typeof actual.id === "string"
            ? createHash("sha256").update(actual.id).digest("hex")
            : null,
        usage,
        outputHash: hash(actual.output),
        latencyToProxyResponseMs: performance.now() - requestStartedMs,
      });
      const calls = actual.output.filter((item) =>
        ["function_call", "custom_tool_call"].includes(item.type),
      );
      lastModelOutput = {
        role: identity.role,
        functionCalls: calls.length,
        outputHash: hash(actual.output),
        itemTypes: actual.output.map((item) =>
          [
            "message",
            "reasoning",
            "function_call",
            "custom_tool_call",
          ].includes(item.type)
            ? item.type
            : "other",
        ),
      };
      assert.ok(
        actual.output.every((item) =>
          ["message", "reasoning", "function_call"].includes(item.type),
        ),
        "unapproved_native_output_kind",
      );
      assert.ok(
        calls.every((call) => call.type === "function_call"),
        "unapproved_native_output_kind",
      );
      for (const frame of nativeOutputItems(data)) {
        const item = frame.item;
        assert.ok(
          item && typeof item === "object" && typeof item.type === "string",
          "native_stream_item_unavailable",
        );
        assert.ok(
          ["message", "reasoning", "function_call"].includes(item.type),
          "unapproved_native_output_kind",
        );
        if (item.type !== "function_call") continue;
        if (item.name)
          assert.ok(
            allowed.some(
              (entry) =>
                entry.name === item.name &&
                (item.namespace === undefined ||
                  item.namespace === entry.namespace),
            ),
            "unapproved_or_ambiguous_native_tool",
          );
        if (frame.done)
          assert.ok(
            calls.some(
              (call) =>
                call.call_id === item.call_id &&
                call.name === item.name &&
                call.arguments === item.arguments &&
                call.namespace === item.namespace,
            ),
            "native_stream_failed",
          );
      }
      const parsed = calls.map((call) => {
        const matches = allowed.filter(
          (entry) =>
            entry.name === call.name &&
            (call.namespace === undefined ||
              call.namespace === entry.namespace),
        );
        assert.equal(matches.length, 1, "unapproved_or_ambiguous_native_tool");
        const entry = matches[0];
        assert.ok(
          typeof call.call_id === "string" &&
            typeof call.arguments === "string" &&
            !issued.has(call.call_id),
          "native_call_identity_invalid",
        );
        const args = JSON.parse(call.arguments);
        assert.ok(
          args && typeof args === "object" && !Array.isArray(args),
          "native_call_arguments_invalid",
        );
        return {
          id: call.call_id,
          name: entry.gatewayName ?? entry.name,
          nativeName: entry.name,
          namespace: entry.namespace,
          args,
          role: identity.role,
          threadHash: hash(identity.root),
          used: false,
        };
      });
      const fixtureCalls = parsed.filter((call) =>
        fixtureNames.includes(call.name),
      );
      if (projectMode && typeof workload.onModelOutput === "function")
        workload.onModelOutput({
          role: identity.role,
          responseMessageHash:
            typeof actual.id === "string"
              ? createHash("sha256").update(actual.id).digest("hex")
              : null,
          calls: fixtureCalls.map(({ name, args }) => ({ name, args })),
        });
      const local = parsed.filter((call) =>
        NATIVE_NAMESPACES.has(call.namespace),
      );
      if (!projectMode)
        assert.ok(
          fixtureCalls.length <= 1 &&
            local.length <= 1 &&
            !(local.length && fixtureCalls.length),
          "native_parallel_action_budget",
        );
      for (const call of parsed) {
        if (call.namespace === MCP_NAMESPACE) {
          assert.ok(allNames.includes(call.name), "mcp_tool_refused");
          if (fixtureNames.includes(call.name)) {
            if (projectMode) {
              assert.equal(
                workload.allowCall({
                  role: identity.role,
                  name: call.name,
                  args: call.args,
                  childReturned: returnSatisfied(),
                }),
                true,
                "project_role_action_refused",
              );
            } else {
              const step =
                identity.role === "parent" ? stats.parent.fixtures : 0;
              assert.ok(
                identity.role !== "parent" || stats.parent.fixtures < goal,
                "parent_fixture_budget",
              );
              assert.ok(
                identity.role !== "child" || stats.child.fixtures === 0,
                "child_fixture_budget",
              );
              assert.ok(
                identity.role !== "parent" ||
                  !stats.spawnCalls ||
                  returnSatisfied(),
                "parent_continued_before_child_admission",
              );
              assert.equal(
                call.name,
                identity.role === "parent"
                  ? fixtureNames[step]
                  : fixtureNames[127],
                "fixture_sequence_mismatch",
              );
              assert.ok(
                call.args.step === step && call.args.operation === "read",
                "fixture_arguments_mismatch",
              );
            }
          }
          call.key = hash({ name: call.name, arguments: call.args });
        } else if (call.name === "spawn_agent") {
          assert.ok(
            identity.role === "parent" &&
              stats.spawnCalls === 0 &&
              (projectMode
                ? workload.requireChild
                : stats.parent.fixtures === spawnAfter),
            "native_spawn_budget_or_timing",
          );
          stats.spawnCalls++;
          spawnCall = call.id;
        } else if (call.name === "wait_agent") {
          assert.ok(
            identity.role === "parent" && stats.spawnCalls === 1,
            "native_wait_without_spawn",
          );
          stats.waitCalls++;
        } else throw new Error("native_host_tool_refused");
        issued.set(call.id, call);
      }
      if (identity.role === "child" && calls.length === 0) {
        const text = finalText(actual.output);
        // ON strips the source's syntactic carrier/display marker for the
        // evidence comparison only. OFF keeps the actual released child bytes
        // exactly: no APPA marker is required and nothing is stripped.
        childValue =
          text === null
            ? undefined
            : arm === "on"
              ? comparisonValue(text)
              : text;
        // Parent admission must preserve the actual server-released child value,
        // which need not echo the whole fixture payload verbatim.
        if (projectMode ? stats.child.fixtures < 1 : stats.child.fixtures !== 1)
          childValue = undefined;
      }
      // Buffering only gates unsafe native execution. These are the exact bytes
      // received, including call IDs, arguments, reasoning and encrypted payloads.
      res.writeHead(
        response.status,
        headers(Object.fromEntries(response.headers)),
      );
      res.end(data);
      if (!projectMode && criteria()) stop("observed_goal_completed");
    } catch (error) {
      if (!(controller.signal.aborted && stopReason))
        lastFailure = safeFailure(error, stage);
      const reason =
        lastFailure?.reason ?? "native_delegation_boundary_failure";
      stats.refusedRequests++;
      if (!res.destroyed) {
        if (!res.headersSent)
          res.writeHead(409, { "content-type": "application/json" });
        res.end('{"error":{"type":"native_delegation_boundary_refused"}}');
      }
      stop(reason);
    } finally {
      if (identity) busy.delete(identity.root);
    }
  }
  let outerStage = "canonical_preparation";
  try {
    catalog = await prepareCatalog({ env, model });
    controller.signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), "appa-native-delegation-"));
    if (rawHistoryPath) transcript = await open(rawHistoryPath, "wx", 0o600);
    server = createServer({ maxHeaderSize: 32768 }, (req, res) => {
      const work = handle(req, res);
      handlers.add(work);
      work.then(
        () => handlers.delete(work),
        () => handlers.delete(work),
      );
    });
    server.requestTimeout = timeoutMs;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (closed) socket.destroy();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const approval = allNames
      .map((name) => `${JSON.stringify(name)}={approval_mode="approve"}`)
      .join(",");
    const mcp = `{appa_benchmark={url=${JSON.stringify(`${base}${gatewayPath}`)},bearer_token_env_var="ARCHESTRA_BENCHMARK_GATEWAY_TOKEN",tools={${approval}}}}`;
    const launch = buildClientLaunch({
      client: "codex",
      base,
      agent,
      session: namespace,
      gatewayToken,
      passthroughKey,
      env,
      args: [],
    });
    const original = launch.args;
    const canonical = [];
    for (let index = 0; index < original.length; index += 2) {
      const setting = original[index + 1];
      if (setting.startsWith("mcp_servers.")) continue;
      if (
        setting.startsWith("model_providers.appa_benchmark.env_http_headers=")
      ) {
        canonical.push(
          "-c",
          'model_providers.appa_benchmark.env_http_headers={"X-Archestra-Virtual-Key"="ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY"}',
        );
      } else canonical.push(original[index], setting);
    }
    launch.args = [
      ...canonical,
      "-c",
      'model_providers.appa_benchmark.http_headers={"X-Archestra-Agent-Id"="openai_codex"}',
      "-c",
      `mcp_servers=${mcp}`,
      "-c",
      "features.code_mode_host=false",
      "-c",
      'web_search="disabled"',
      "-c",
      `model_catalog_json=${JSON.stringify(catalog.filename)}`,
      "--ask-for-approval",
      "never",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--json",
      "--cd",
      directory,
      "--model",
      model,
      "-",
    ];
    launch.cwd = directory;
    // Native spawning forks persisted rollouts. Keep those under the canonical
    // helper's owned home, whose auth is hardlinked rather than copied.
    launch.env.CODEX_HOME = dirname(catalog.filename);
    delete launch.env.ARCHESTRA_BENCHMARK_SESSION_ID;
    delete launch.env.CLAUDE_CODE_OAUTH_TOKEN;
    launch.env.NO_PROXY = [launch.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
      .filter(Boolean)
      .join(",");
    launch.stdin = projectMode
      ? workload.prompt
      : inventoryOnly
        ? "Discover the configured task MCP tool declarations only. No inference or tool execution is requested."
         : `${prefixText}\nBenchmark namespace: ${namespace}.\nThis is a real native delegation qualification, not a simulation. Use only advertised tools. Never use shell, files, web search, or invented tool results.\nPerform exactly ${goal} parent fixture reads, one per model response, sequential steps 0 through ${goal - 1}. For step i call the EXACT advertised native tool nativeFixtureNames[i] with {step:i,operation:"read"}. These are native spellings, not raw gateway names. Use authentic recovery helpers only when an actual ruling offers them; helpers do not advance the fixture step.\nAfter exactly ${spawnAfter} confirmed parent fixture reads, use your actual native collaboration.spawn_agent ONCE to create one read-only child. Tell the child to include the benchmark namespace in its task context, call the exact native tool ${promptFixtureNames[127]} with {step:0,operation:"read"} exactly once, and return its exact result text with no commentary. Do not override models or permissions. If the actual schema requires a requested task name, supply it for the spawn, but use only the real native acknowledgment's identity afterward. Let your own native executor produce acknowledgments and mailbox messages; never fabricate acknowledgments, IDs, receipts, results, or completion states.\nUse your actual wait_agent until that child finishes. Do not continue parent fixture reads until the genuine child's final answer has arrived. Then finish the remaining parent reads and end.\nnativeFixtureNames=${JSON.stringify(promptFixtureNames)}\n`;
    outerStage = "native_run";
    if (measurements) {
      measurements.startTask();
      timingStarted = true;
    }
    running = Promise.resolve().then(() =>
      runNative(launch, {
        signal: controller.signal,
        timeoutMs,
        onProcess: (terminate) => {
          terminateNative = terminate;
          if (controller.signal.aborted) terminate();
        },
      }),
    );
    native = await running;
    if (measurements) {
      measurements.finishTask({
        success: criteria() && native?.exitCode === 0,
      });
      timingFinished = true;
    }
  } catch (error) {
    if (measurements && timingStarted && !timingFinished) {
      measurements.finishTask({ success: false });
      timingFinished = true;
    }
    lastFailure ??= safeFailure(error, outerStage);
    failure = lastFailure.reason;
  } finally {
    clearTimeout(timer);
    closed = true;
    controller.abort();
    terminateNative();
    try {
      await within(
        (async () => {
          const stopped = server
            ? new Promise((resolve) => server.close(resolve))
            : Promise.resolve();
          server?.closeIdleConnections?.();
          server?.closeAllConnections?.();
          for (const socket of sockets) socket.destroy();
          await dispatcher.destroy();
          await stopped;
          await Promise.allSettled([...handlers, running]);
        })(),
        7000,
      );
    } catch {
      cleanupFailure = true;
    }
    try {
      await within(
        (async () => {
          try {
            await rawWrites;
          } finally {
            await Promise.all([
              transcript?.close(),
              catalog?.close(),
              directory
                ? rm(directory, { recursive: true, force: true })
                : undefined,
            ]);
          }
        })(),
        3000,
      );
    } catch {
      cleanupFailure = true;
    }
    for (const signal of SIGNALS) process.off(signal, interrupt);
    externalSignal?.removeEventListener("abort", interrupt);
  }
  const behavioralCriteriaMet =
    criteria() &&
    (!projectMode || native?.exitCode === 0) &&
    !failure &&
    !cleanupFailure &&
    (stopReason === "observed_goal_completed" || !stopReason);
  const realNativeProcess = runNative === nativeProcess;
  const nativeExecutionSource = realNativeProcess
    ? "native-cli-process"
    : "injected-test-process-boundary";
  const completed = behavioralCriteriaMet && realNativeProcess;
  const completeUsage = (value) =>
    ["totalInput", "uncachedInput", "cacheRead", "cacheWrite", "output"].every(
      (key) => Number.isFinite(value?.[key]) && value[key] >= 0,
    ) &&
    value.totalInput ===
      value.uncachedInput + value.cacheRead + value.cacheWrite;
  if (
    !lastFailure &&
    !completed &&
    !inventoryOnly &&
    stats.parent.fixtures === 0 &&
    stats.spawnCalls === 0 &&
    lastModelOutput?.role === "parent" &&
    lastModelOutput.functionCalls === 0
  )
    lastFailure = {
      stage: "model_output",
      reason: "native_parent_returned_no_tool_calls",
      unknownMessageHash: null,
    };
  return {
    kind: projectMode
      ? "native_codex_project_summary"
      : "native_codex_delegation_summary",
    mode,
    arm,
    completed,
    inconclusive: !completed,
    full100Claim: !projectMode && mode === "full" && completed,
    parentFixtureGoal: projectMode ? null : goal,
    projectWorkload: projectMode,
    timing: measurements?.summary() ?? null,
    behavioralCriteriaMet,
    nativeExecutionSource,
    inventoryProbeOnly: inventoryOnly,
    providerRequestAttempts,
    initialTaskInventory,
    lastModelOutput,
    lastFailure,
    nativeToolNameBindings: initialNameBindings,
    nativeFixtureNames: fixtureNames.map(
      (rawName) =>
        initialNameBindings.find((binding) => binding.gatewayName === rawName)
          ?.nativeName ?? null,
    ),
    identityBinding: {
      source: "authenticated-tools-list-plus-exact-native-leading-attestation",
      namespace: MCP_NAMESPACE,
      localSignatureVerification: false,
      declarationsOrCallNamesRewritten: false,
    },
    requestedModel: model,
    observedModels: [...observedModels],
    observedServiceTiers: [...observedServiceTiers],
    modelIdentitySource:
      observedModels.size > 0 ? "provider-response-completed" : null,
    stopReason:
      failure ??
      stopReason ??
      lastFailure?.reason ??
      (completed
        ? "native_task_completed"
        : "native_exited_before_qualification"),
    cleanupFailure,
    parent: stats.parent,
    child: stats.child,
    totalModelRequests: stats.totalModelRequests,
    usageKnownResponses: {
      parent: stats.parent.usage.filter(completeUsage).length,
      child: stats.child.usage.filter(completeUsage).length,
    },
    usageUnknownResponses: {
      parent:
        stats.parent.modelRequests -
        stats.parent.usage.filter(completeUsage).length,
      child:
        stats.child.modelRequests -
        stats.child.usage.filter(completeUsage).length,
    },
    spawnCalls: stats.spawnCalls,
    waitCalls: stats.waitCalls,
    spawnAckObserved: stats.spawnAckObserved,
    waitResultsObserved: stats.waitResultsObserved,
    terminalReturnObserved: stats.terminalReturnObserved,
    terminalReturnAdmitted: stats.terminalReturnAdmitted,
    returnEvidence: {
      ...returnEvidence,
      observedChildValueHash:
        childValue === undefined ? null : hash(childValue),
    },
    parentNativeHash: scope.parent ? hash(scope.parent) : null,
    childNativeHash: scope.child ? hash(scope.child) : null,
    discoveredToolCount: stats.catalogToolsSeen,
    ambiguousDispatches: stats.ambiguousDispatches,
    nativeExitCode: Number.isInteger(native?.exitCode) ? native.exitCode : null,
    canonicalRouting: {
      nativeRollouts: "task-private-codex-home",
      staticHarnessSessionHeaders: false,
      nativeIdentityRewritten: false,
      historyOverlay: false,
    },
    admissionEvidence:
      projectMode && !workload.requireChild
        ? "not_applicable_no_child"
        : arm === "on"
          ? "structured-provider-bound-return-matches-observed-child-value; server-retained-ChildEnd-is-authority"
          : "provider-bound-envelope-carries-exact-unchanged-child-value; enforcement=off native-return-control, not a protected-return proof; no APPA marker claim",
    localSignatureVerification: false,
    limitations: [
      "Caller must verify deployment/policy ON and restore them independently.",
      "MCP attribution requires a unique actual released name/argument match; ambiguous calls are never credited.",
      "Display markers are only compared syntactically, never treated as return authority.",
      "Missing relay evidence, unsupported native envelopes or changed bytes remain inconclusive.",
      "CLI exit zero is not proof; pilot completion never claims100parentfixtures.",
      ...(arm === "off"
        ? [
            "OFF arm: exactValueMatched is an enforcement-off native-return control; terminalReturnAdmitted stays false by construction.",
          ]
        : []),
    ],
  };
}

// Pure safe projection, also usable offline on the private transcript's first
// native_request.input. It never returns schemas, text, metadata or header values.
export function inspectCodexNativeTaskInventory({
  body,
  fixtureNames,
  helperNames,
  nameBindings,
}) {
  const fixtures = new Set(fixtureNames);
  const known = new Set([...fixtureNames, ...helperNames]);
  const declarations = [];
  const toolSearchDeclarations = [];
  let seen = 0;
  const execution = (value) =>
    [
      "client",
      "server",
      "direct",
      "deferred",
      "native",
      "auto",
      "serial",
      "parallel",
    ].includes(value)
      ? value
      : null;
  const publicType = (value) =>
    typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "other";
  const walk = (value, path, namespace, inheritedDefer = null) => {
    assert.ok(++seen <= 8192, "native_inventory_observation_limit");
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${index}]`, namespace, inheritedDefer);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "namespace") {
      walk(
        value.tools,
        `${path}.tools`,
        value.name,
        typeof value.defer_loading === "boolean"
          ? value.defer_loading
          : inheritedDefer,
      );
      return;
    }
    const ns = value.namespace ?? namespace;
    const binding = nameBindings?.find(
      (entry) => entry.namespace === ns && entry.nativeName === value.name,
    );
    const canonicalName =
      binding?.gatewayName ??
      (nameBindings === undefined && known.has(value.name) ? value.name : null);
    const defer =
      typeof value.defer_loading === "boolean"
        ? value.defer_loading
        : inheritedDefer;
    const mode = value.execution ?? value.execution_mode;
    if (
      value.type === "tool_search" ||
      (value.name === "tool_search" &&
        (ns === undefined || NATIVE_NAMESPACES.has(ns)))
    ) {
      toolSearchDeclarations.push({
        sourcePath: path,
        type: publicType(value.type),
        executionMode: execution(mode),
        executionModeHash: mode === undefined ? null : hash(mode),
      });
    }
    const configuredNamespace =
      typeof ns === "string" &&
      (ns === MCP_NAMESPACE ||
        ns === "appa_benchmark" ||
        ns.startsWith(`${MCP_NAMESPACE}_`));
    const taskAlias =
      typeof value.name === "string" &&
      (value.name.startsWith(`${MCP_NAMESPACE}__`) ||
        value.name.startsWith(`${MCP_NAMESPACE}.`));
    if (!configuredNamespace && !known.has(value.name) && !taskAlias) return;
    const name =
      typeof value.name === "string" &&
      /^[A-Za-z0-9_.:-]{1,256}$/.exec(value.name)?.[0] === value.name
        ? value.name
        : null;
    const publicNamespace =
      typeof ns === "string" &&
      /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.exec(ns)?.[0] === ns
        ? ns
        : null;
    declarations.push({
      sourcePath: path,
      name,
      nameHash: typeof value.name === "string" ? hash(value.name) : null,
      canonicalName,
      namespace: publicNamespace,
      namespaceType: ns === undefined ? "absent" : typeof ns,
      namespaceHash: ns === undefined ? null : hash(ns),
      type: value.type === undefined ? "implicit" : publicType(value.type),
      deferLoading:
        typeof value.defer_loading === "boolean" ? value.defer_loading : null,
      inheritedDeferLoading: inheritedDefer,
      effectiveDeferLoading: defer,
      executionMode: execution(mode),
      executionModeHash: mode === undefined ? null : hash(mode),
      canonicalFixtureMatch: fixtures.has(canonicalName),
      canonicalHelperMatch: helperNames.includes(canonicalName),
    });
  };
  for (const key of ["tools", "additional_tools"])
    if (body?.[key] !== undefined) walk(body[key], key);
  for (const [index, item] of (body?.input ?? []).entries())
    if (
      ["additional_tools", "tool_search_output"].includes(item?.type) &&
      item.tools !== undefined
    )
      walk(item.tools, `input[${index}].tools`);
  const matched = new Set(
    declarations
      .filter((item) => item.canonicalFixtureMatch)
      .map((item) => item.canonicalName),
  );
  return {
    observation:
      "actual-structural-task-mcp-declarations-not-executor-or-provider-visibility-proof",
    bodySlotsPresent: {
      tools: Object.hasOwn(body ?? {}, "tools"),
      additional_tools: Object.hasOwn(body ?? {}, "additional_tools"),
      input: Object.hasOwn(body ?? {}, "input"),
    },
    configuredMcpNamespace: MCP_NAMESPACE,
    declarationCount: declarations.length,
    canonicalFixtureCount: matched.size,
    missingCanonicalFixtures: fixtureNames.filter((name) => !matched.has(name)),
    deferredFixtureCount: declarations.filter(
      (item) =>
        item.canonicalFixtureMatch && item.effectiveDeferLoading === true,
    ).length,
    declarations,
    toolSearchDeclarations,
    deferSource:
      "openai/resources/responses/responses.d.ts:439-442,582-585,5730-5749",
  };
}

function safeFailure(error, stage) {
  const first =
    typeof error?.message === "string"
      ? error.message.split(/\r?\n/, 1)[0]
      : "";
  const known = SAFE_FAILURES.has(first);
  return {
    stage,
    reason: known ? first : "native_delegation_boundary_failure",
    unknownMessageHash:
      !known && typeof error?.message === "string" ? hash(error.message) : null,
  };
}

function bindObservedGatewayNames(body, gatewayTools) {
  const byMarker = new Map();
  for (const tool of gatewayTools.values()) {
    const marker = leadingAttestation(tool.description);
    if (!marker) continue;
    assert.ok(!byMarker.has(marker), "native_gateway_name_collision");
    byMarker.set(marker, tool.name);
  }
  const bindings = [];
  const wire = new Map();
  const canonical = new Map();
  let visited = 0;
  const walk = (value, path, namespace) => {
    assert.ok(++visited <= 8192, "native_inventory_observation_limit");
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${index}]`, namespace);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "namespace") {
      walk(value.tools, `${path}.tools`, value.name);
      return;
    }
    const ns = value.namespace ?? namespace;
    if (ns !== MCP_NAMESPACE || typeof value.name !== "string") return;
    const marker = leadingAttestation(value.description);
    const gatewayName = marker
      ? byMarker.get(marker)
      : gatewayTools.has(value.name) &&
          !leadingAttestation(gatewayTools.get(value.name).description)
        ? value.name
        : undefined;
    if (!gatewayName) return;
    // A wire spelling that is also a DIFFERENT raw identity is ambiguous even
    // when one marker happens to match. Never resolve a collision by list order.
    assert.ok(
      !gatewayTools.has(value.name) || value.name === gatewayName,
      "native_gateway_name_collision",
    );
    const previousWire = wire.get(value.name);
    const previousCanonical = canonical.get(gatewayName);
    const schemaHash = hash(value);
    assert.ok(
      !previousWire ||
        (previousWire.gatewayName === gatewayName &&
          previousWire.schemaHash === schemaHash),
      "native_gateway_name_collision",
    );
    assert.ok(
      !previousCanonical || previousCanonical === value.name,
      "native_gateway_name_collision",
    );
    if (!previousWire) {
      const binding = {
        nativeName: value.name,
        gatewayName,
        namespace: ns,
        sourcePath: path,
        schemaHash,
        source: marker
          ? "same-opaque-leading-attestation-as-authenticated-tools-list"
          : "exact-authenticated-name-no-rename",
        attestationMatched: !!marker,
        localSignatureVerification: false,
      };
      bindings.push(binding);
      wire.set(value.name, binding);
      canonical.set(gatewayName, value.name);
    }
  };
  for (const key of ["tools", "additional_tools"])
    if (body[key] !== undefined) walk(body[key], key);
  for (const [index, item] of (body.input ?? []).entries())
    if (
      ["additional_tools", "tool_search_output"].includes(item?.type) &&
      item.tools !== undefined
    )
      walk(item.tools, `input[${index}].tools`);
  return bindings;
}

function leadingAttestation(description) {
  if (typeof description !== "string") return undefined;
  // Exact carrier syntax from tool-attestation.ts:62-73,148-151. Equality to
  // authenticated discovery is a transport binding, NOT local MAC verification.
  const match =
    /^\[\[gwa1\.[A-Za-z0-9_-]{1,720}\.[A-Za-z0-9_-]{22}\]\](?:\n|$)/.exec(
      description,
    );
  return match ? match[0].replace(/\n$/, "") : undefined;
}

function filterDeclarations({
  body,
  role,
  fixtures,
  helpers,
  nameBindings,
  allowChildProjectTools = false,
}) {
  const allowed = [];
  const walk = (value, namespace) => {
    if (Array.isArray(value))
      return value.map((item) => walk(item, namespace)).filter(Boolean);
    if (!value || typeof value !== "object") return null;
    if (value.type === "namespace") {
      const tools = walk(value.tools, value.name);
      return tools?.length ? { ...value, tools } : null;
    }
    const name = value.name;
    const ns = value.namespace ?? namespace;
    const binding = nameBindings.find(
      (entry) => entry.namespace === ns && entry.nativeName === name,
    );
    const mcp =
      ns === MCP_NAMESPACE &&
      [
        ...(role === "child" && !allowChildProjectTools
          ? [fixtures[127]]
          : fixtures),
        ...helpers,
      ].includes(binding?.gatewayName);
    const local =
      role === "parent" &&
      NATIVE_NAMESPACES.has(ns) &&
      // Keep the cached declaration prefix stable. The output boundary rejects
      // a second spawn before the native executor receives it.
      (name === "wait_agent" || name === "spawn_agent");
    if (!mcp && !local) return null;
    if (value.type !== undefined && value.type !== "function")
      throw new Error("unsupported_actual_native_declaration");
    allowed.push({
      name,
      namespace: ns,
      ...(binding ? { gatewayName: binding.gatewayName } : {}),
    });
    return value;
  };
  for (const key of ["tools", "additional_tools"])
    if (body[key] !== undefined) body[key] = walk(body[key]);
  for (const item of body.input ?? [])
    if (
      ["additional_tools", "tool_search_output"].includes(item?.type) &&
      item.tools !== undefined
    )
      item.tools = walk(item.tools);
  return allowed;
}

function nativeIds(body, headers) {
  const flat = object(body.client_metadata);
  const nested = jsonObject(flat?.["x-codex-turn-metadata"]);
  const turn = jsonObject(headers["x-codex-turn-metadata"]);
  const sessions = [];
  const threads = [];
  for (const claim of [flat, nested, turn]) {
    if (typeof claim?.session_id === "string" && claim.session_id.trim())
      sessions.push(claim.session_id.trim());
    if (typeof claim?.thread_id === "string" && claim.thread_id.trim())
      threads.push(claim.thread_id.trim());
  }
  if (typeof headers["session-id"] === "string" && headers["session-id"].trim())
    sessions.push(headers["session-id"].trim());
  assert.ok(
    new Set(sessions).size <= 1 && new Set(threads).size <= 1,
    "contradictory_native_identity",
  );
  const metadata = flat ?? object(body.metadata);
  const parent =
    headers["x-codex-parent-thread-id"] ??
    turn?.parent_thread_id ??
    metadata?.parent_thread_id ??
    metadata?.parent_id ??
    metadata?.["x-codex-parent-thread-id"] ??
    jsonObject(metadata?.["x-codex-turn-metadata"])?.parent_thread_id;
  return {
    root: threads[0] ?? sessions[0],
    parent: typeof parent === "string" && parent.trim() ? parent.trim() : null,
    guardian:
      headers["x-openai-subagent"] === "guardian" ||
      metadata?.turn_trigger === "guardian_review" ||
      turn?.turn_trigger === "guardian_review",
  };
}

function completedValues(input, issued, ack) {
  const result = [];
  for (const item of input ?? []) {
    if (
      item.type === "function_call_output" &&
      issued.get(item.call_id)?.name === "wait_agent"
    ) {
      const output = jsonObject(item.output);
      for (const [id, state] of Object.entries(output?.status ?? {}))
        if (typeof state?.completed === "string" && ack?.agentId === id)
          result.push(state.completed);
    }
    if (
      item.type === "agent_message" &&
      ack?.taskName &&
      item.author === ack.taskName &&
      typeof item.recipient === "string"
    ) {
      const text = (item.content ?? [])
        .filter((part) => part.type === "input_text")
        .map((part) => part.text)
        .join("");
      const header = `Message Type: FINAL_ANSWER\nTask name: ${item.recipient}\nSender: ${item.author}\nPayload:\n`;
      if (text.startsWith(header)) result.push(text.slice(header.length));
    }
  }
  return result;
}

function comparisonValue(text) {
  // Evidence only, pinned to child-return.ts:285-348,625-633. Do not decode or
  // invent signed carriers. This is evidence-only transport normalization, not
  // signature verification (child-trajectory-receipt.ts:26-42,202-234,414-430).
  const carriers = [
    ...text.matchAll(
      /(?:(?:\u2584\u2588\u2584\u2584\u2584\u2588\u2584\n\u2588\u2588\u2584\u2588\u2584\u2588\u2588|\u2584\u2588\u2584\u2584\u2584\u2588\u2584\s+\u2588\u2588\u2584\u2588\u2584\u2588\u2588)\s+)?(?:started subagent|started protected subagent|protected delegated session)(?:\s+[A-Za-z0-9_:-]+)?\s+[A-Za-z0-9_-]{1,64}\s*\n?\[appa\] child trajectory appact2-[A-Za-z0-9_-]+\.[0-9a-f]{64}\./g,
    ),
  ];
  if (carriers.length > 64) return undefined;
  for (const carrier of carriers.reverse()) {
    let start = carrier.index;
    let end = start + carrier[0].length;
    for (let count = 0; count < 2 && text[start - 1] === "\n"; count++)
      start -= text[start - 2] === "\r" ? 2 : 1;
    for (let count = 0; count < 2; count++) {
      if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
      else if (text[end] === "\n") end++;
      else break;
    }
    text = text.slice(0, start) + text.slice(end);
  }
  if (text.includes("appact2-")) return undefined;
  const pattern =
    /(?:^|(?<=\n))[\t ]*(?:\u2584\u2588\u2584\u2584\u2584\u2588\u2584(?:\r?\n|[\t ]{1,8})\u2588\u2588\u2584\u2588\u2584\u2588\u2588[\t ]{1,8})?(?:finished subagent|finished protected subagent|protected subagent session|protected subagent return|protected delegated return)[\t ]+(?:[A-Za-z0-9_:-]{1,512}[\t ]+)?[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}[\t ]*(?=\r?\n|$)/gm;
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  let start = matches[0].index;
  while (start > 0 && /[\t ]/.test(text[start - 1])) start--;
  for (
    let count = 0;
    count < 2 && start > 0 && text[start - 1] === "\n";
    count++
  ) {
    start--;
    if (text[start - 1] === "\r") start--;
  }
  return (
    text.slice(0, start) + text.slice(matches[0].index + matches[0][0].length)
  );
}

function nativeOutputItems(data) {
  const items = [];
  for (const frame of data
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    .split("\n\n")) {
    const value = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!value || value === "[DONE]") continue;
    const event = JSON.parse(value);
    if (
      ["response.output_item.added", "response.output_item.done"].includes(
        event.type,
      )
    )
      items.push({ item: event.item, done: event.type.endsWith(".done") });
  }
  return items;
}
function finalText(output) {
  const last = output
    .filter((item) => item.type === "message" && item.role === "assistant")
    .at(-1);
  const parts = last?.content;
  return Array.isArray(parts) &&
    parts.every(
      (part) => part.type === "output_text" && typeof part.text === "string",
    )
    ? parts.map((part) => part.text).join("")
    : null;
}
function completedResponse(data) {
  let found;
  for (const frame of data
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    .split("\n\n")) {
    const value = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!value || value === "[DONE]") continue;
    const event = JSON.parse(value);
    if (
      ["error", "response.failed", "response.incomplete"].includes(event.type)
    )
      throw new Error("native_stream_failed");
    if (event.type === "response.completed") {
      assert.ok(!found, "duplicate_completed_response");
      found = event.response;
    }
  }
  return found;
}
function rpcResult(data, id) {
  let values;
  try {
    values = [JSON.parse(data)];
  } catch {
    values = data
      .toString()
      .replace(/\r\n/g, "\n")
      .split("\n\n")
      .map((frame) =>
        frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      )
      .filter(Boolean)
      .map(JSON.parse);
  }
  return values.findLast((value) => value.id === id);
}
function safeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const number = (value) =>
    Number.isFinite(value) && value >= 0 ? value : undefined;
  const details = object(raw.input_tokens_details) ?? {};
  return normalizeUsage("openai-responses", {
    input_tokens: number(raw.input_tokens),
    output_tokens: number(raw.output_tokens),
    input_tokens_details: {
      cached_tokens: number(
        Object.hasOwn(details, "cached_tokens")
          ? details.cached_tokens
          : raw.cache_read_input_tokens,
      ),
      cache_write_tokens: number(
        Object.hasOwn(details, "cache_write_tokens")
          ? details.cache_write_tokens
          : (raw.cache_write_tokens ?? raw.cache_creation_input_tokens),
      ),
    },
  });
}
function modelMatches(actual, expected) {
  return (
    actual === expected ||
    (typeof actual === "string" &&
      actual.startsWith(`${expected}-`) &&
      /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(expected.length + 1)))
  );
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}
function jsonObject(value) {
  if (value === undefined) return undefined;
  return object(typeof value === "string" ? JSON.parse(value) : value);
}
function headers(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        ![
          "host",
          "connection",
          "content-length",
          "transfer-encoding",
          "content-encoding",
          "accept-encoding",
          "upgrade",
          "keep-alive",
        ].includes(key.toLowerCase()),
    ),
  );
}
async function readBytes(stream) {
  const parts = [];
  let size = 0;
  for await (const part of stream ?? []) {
    size += part.length;
    assert.ok(size <= MAX_BYTES, "body_limit");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("cleanup_timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function abortableDelay(ms, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new Error("interrupted"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
function hash(value) {
  const canonical = (node) =>
    Array.isArray(node)
      ? node.map(canonical)
      : node && typeof node === "object"
        ? Object.fromEntries(
            Object.keys(node)
              .sort()
              .map((key) => [key, canonical(node[key])]),
          )
        : node;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "undefined")
    .digest("hex");
}

async function nativeProcess(launch, { signal, timeoutMs, onProcess }) {
  signal.throwIfAborted();
  const group = process.platform !== "win32";
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    detached: group,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let force;
  const kill = (name) => {
    try {
      if (group && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      /* Owned process already exited. */
    }
  };
  const stop = () => {
    kill("SIGTERM");
    force ??= setTimeout(() => kill("SIGKILL"), 1000);
    force.unref();
  };
  onProcess(stop);
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  let size = 0;
  child.stdout.on("data", (part) => {
    size += part.length;
    if (size > MAX_BYTES) stop();
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(launch.stdin);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ exitCode }));
    });
  } finally {
    kill("SIGKILL");
    clearTimeout(timer);
    clearTimeout(force);
    signal.removeEventListener("abort", stop);
  }
}

const { Agent } = createRequire(
  new URL("../backend/package.json", import.meta.url),
)("undici");
const MAX_BYTES = 4 * 1024 * 1024;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const MCP_NAMESPACE = "mcp__appa_benchmark";
const NATIVE_NAMESPACES = new Set([
  "functions",
  "collaboration",
  "multi_agent_v1",
]);
const DISCOVERY = [
  "initialize",
  "notifications/initialized",
  "tools/list",
  "ping",
  "server/discover",
];
const SAFE_FAILURES = new Set([
  "native_gateway_name_collision",
  "native_prompt_tool_mapping_required",
  "native_stream_item_unavailable",
  "native_inventory_observation_limit",
  "native_task_fixture_declarations_missing",
  "native_task_tools_deferred_without_search",
  "interrupted",
  "native_delegation_timeout",
  "native_proxy_refusal",
  "route_refused",
  "gateway_auth_refused",
  "gateway_method_refused",
  "gateway_tool_refused",
  "unattributed_native_gateway_call",
  "actual_gateway_catalog_incomplete",
  "actual_fixture_execution_unconfirmed",
  "virtual_key_refused",
  "noncanonical_fixed_session_header",
  "native_user_agent_required",
  "native_identity_unavailable",
  "first_thread_is_not_parent",
  "unrelated_native_session",
  "more_than_one_native_child",
  "parallel_same_thread_request",
  "native_request_budget",
  "native_bootstrap_or_discovery_incomplete",
  "native_mcp_namespace_missing",
  "actual_native_delegation_schemas_missing",
  "actual_model_response_unconfirmed",
  "unapproved_native_output_kind",
  "unapproved_or_ambiguous_native_tool",
  "native_call_identity_invalid",
  "native_call_arguments_invalid",
  "native_parallel_action_budget",
  "mcp_tool_refused",
  "parent_fixture_budget",
  "child_fixture_budget",
  "parent_continued_before_child_admission",
  "fixture_sequence_mismatch",
  "fixture_arguments_mismatch",
  "native_spawn_budget_or_timing",
  "native_wait_without_spawn",
  "native_host_tool_refused",
  "unsupported_actual_native_declaration",
  "contradictory_native_identity",
  "native_stream_failed",
  "duplicate_completed_response",
  "body_limit",
  "capture_cursor_invalid",
]);
