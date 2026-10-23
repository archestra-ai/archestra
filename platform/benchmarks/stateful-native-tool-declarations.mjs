import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeClaude } from "./claude-parity-ab.mjs";
import { buildClientLaunch } from "./native-client.mjs";

export async function captureNativeToolDeclarations({
  agent,
  session,
  gatewayToken,
  passthroughKey,
  env = process.env,
  names = ["Agent"],
  runNative = runNativeClaude,
  timeoutMs = 120000,
}) {
  if (
    !Array.isArray(names) ||
    names.length < 1 ||
    names.length > 8 ||
    names.some(
      (name) =>
        typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name),
    ) ||
    new Set(names).size !== names.length
  )
    throw failure("native_declaration_names_invalid");
  if (
    ![agent, session].every(
      (value) => typeof value === "string" && /^[a-z0-9-]{1,128}$/i.test(value),
    ) ||
    !gatewayToken ||
    !passthroughKey ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120000
  )
    throw failure("native_declaration_options_invalid");
  names = [...names];
  const diagnostics = {
    admittedMessages: 0,
    additionalMessages: 0,
    refusedRequests: 0,
    headerRefusals: 0,
    providerRequests: 0,
  };
  const controller = new AbortController();
  let directory;
  let running;
  let captured;
  let captureError;
  let captureFinished = false;
  let abortCode;
  let result;
  let pendingError;
  const path = `/v1/anthropic/${agent}/v1/messages`;
  const server = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    async (req, res) => {
      const matching =
        req.method === "POST" &&
        (req.url === path || req.url === `${path}?beta=true`) &&
        req.headers["x-appa-session-id"] === session &&
        req.headers["x-archestra-virtual-key"] === passthroughKey;
      diagnostics.refusedRequests++;
      if (
        !matching ||
        diagnostics.admittedMessages > 0 ||
        controller.signal.aborted
      ) {
        if (matching && diagnostics.admittedMessages > 0)
          diagnostics.additionalMessages++;
        req.resume();
        refuse(res);
        return;
      }
      diagnostics.admittedMessages++;
      try {
        const parts = [];
        let bytes = 0;
        for await (const part of req) {
          bytes += part.byteLength;
          if (bytes > MAX_BODY_BYTES)
            throw failure("native_declaration_body_too_large");
          parts.push(part);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        } catch {
          throw failure("native_declaration_body_invalid");
        }
        if (!Array.isArray(body?.tools))
          throw failure("native_declarations_not_captured");
        const declarations = names.map((name) => {
          const matches = body.tools.filter((tool) => tool?.name === name);
          if (matches.length === 0)
            throw failure("native_declarations_missing");
          if (matches.length !== 1)
            throw failure("native_declarations_ambiguous");
          const declaration = matches[0];
          if (
            !declaration.input_schema ||
            typeof declaration.input_schema !== "object" ||
            Array.isArray(declaration.input_schema)
          )
            throw failure("native_declaration_schema_invalid");
          return structuredClone(declaration);
        });
        // Only requested declarations survive this handler. No auth, native system,
        // transcript, metadata or unrequested tools are retained or returned.
        captured = declarations;
      } catch (error) {
        captureError = ERROR_CODES.has(error?.code)
          ? error.code
          : "native_declaration_body_invalid";
      } finally {
        captureFinished = true;
        clearTimeout(timer);
        // A terminal capture (including a fixed validation error) must not wait
        // through native HTTP retries. Flush the refusal, then stop the child;
        // this intentional stop is not an interruption/deadline failure.
        if (!res.destroyed) {
          res.once("finish", () => controller.abort());
          res.once("close", () => controller.abort());
          refuse(res);
        } else controller.abort();
      }
    },
  );
  server.maxHeadersCount = 64;
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 10000);
  server.on("clientError", (_error, socket) => {
    diagnostics.refusedRequests++;
    diagnostics.headerRefusals++;
    if (!socket.destroyed)
      socket.end(
        "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
  });
  const abort = (code) => {
    if (!captureFinished) abortCode ??= code;
    controller.abort();
    server.closeAllConnections();
  };
  const interrupt = () => abort("native_declaration_interrupted");
  const timer = setTimeout(
    () => abort("native_declaration_timeout"),
    timeoutMs,
  );
  for (const signal of SIGNALS) process.on(signal, interrupt);
  try {
    directory = await mkdtemp(join(tmpdir(), "appa-native-declarations-"));
    const mcpConfig = join(directory, "mcp.json");
    await writeFile(mcpConfig, '{"mcpServers":{}}', { mode: 0o600 });
    await new Promise((resolve, reject) => {
      server.once("error", () =>
        reject(failure("native_declaration_listener_failed")),
      );
      server.listen(0, "127.0.0.1", resolve);
    });
    controller.signal.throwIfAborted();
    const launch = buildClientLaunch({
      client: "claude",
      base: `http://127.0.0.1:${server.address().port}`,
      agent,
      session,
      gatewayToken,
      passthroughKey,
      mcpConfig,
      env,
      args: [
        "--print",
        "--model",
        env.ARCHESTRA_BENCHMARK_CLAUDE_MODEL ?? "sonnet",
        "--tools",
        names.join(","),
        "--session-id",
        session,
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--output-format",
        "json",
        "Declaration discovery only. Do not execute tools.",
      ],
    });
    launch.env.NO_PROXY = [launch.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
      .filter(Boolean)
      .join(",");
    // The native client owns authentication. Its output is intentionally ignored:
    // HTTP 409 is the expected result, never a fabricated assistant completion.
    running = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return runNative(launch, { signal: controller.signal, timeoutMs });
      })
      .then(
        () => null,
        () => "native_declaration_client_failed",
      );
    const nativeError = await running;
    if (abortCode) throw failure(abortCode);
    if (captureError) throw failure(captureError);
    if (!captured)
      throw failure(nativeError ?? "native_declarations_not_captured");
    result = {
      tools: captured,
      requestedNames: names,
      ...diagnostics,
      nativeCompleted: true,
      transport: "native-declaration-discovery-only",
    };
  } catch (error) {
    const code =
      abortCode ??
      (ERROR_CODES.has(error?.code)
        ? error.code
        : "native_declaration_capture_failed");
    pendingError = failure(code, diagnostics);
  } finally {
    clearTimeout(timer);
    controller.abort();
    server.closeAllConnections();
    try {
      await new Promise((resolve) => server.close(resolve));
      // runNativeClaude terminates the native child on abort, escalating to SIGKILL
      // after five seconds. A process-boundary substitute must honor the signal too.
      await running;
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      pendingError = failure("native_declaration_cleanup_failed", diagnostics);
    } finally {
      for (const signal of SIGNALS) process.removeListener(signal, interrupt);
    }
  }
  if (pendingError) throw pendingError;
  return result;
}

function refuse(res) {
  res.writeHead(409, {
    "content-type": "application/json",
    connection: "close",
  });
  res.end(
    '{"type":"error","error":{"type":"invalid_request_error","message":"Native declaration discovery refuses model execution."}}',
  );
}

function failure(code, diagnostics) {
  const error = new Error(code);
  error.code = code;
  if (diagnostics) error.diagnostics = { ...diagnostics };
  return error;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const ERROR_CODES = new Set([
  "native_declaration_names_invalid",
  "native_declaration_options_invalid",
  "native_declaration_body_too_large",
  "native_declaration_body_invalid",
  "native_declarations_not_captured",
  "native_declarations_missing",
  "native_declarations_ambiguous",
  "native_declaration_schema_invalid",
  "native_declaration_interrupted",
  "native_declaration_timeout",
  "native_declaration_listener_failed",
  "native_declaration_client_failed",
  "native_declaration_capture_failed",
  "native_declaration_cleanup_failed",
]);
