import { readFileSync } from "node:fs";
import vm from "node:vm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import ts from "typescript";
import config, { validateShutdownPodGrace } from "../config";
import {
  beginLlmProxyDrain,
  drainLlmProxyRequests,
  registerLlmProxyDrain,
} from "../server/llm-proxy-drain";
import {
  drainBackgroundWork,
  trackBackgroundWork,
} from "../utils/background-work";

const opts = JSON.parse(process.argv[2]);
validateShutdownPodGrace(
  config.shutdown.podGraceSeconds,
  config.shutdown.drainSeconds,
  config.shutdown.cleanupSeconds,
  config.kb.taskWorkerShutdownTimeoutSeconds,
);
const started = Date.now();
const emit = (event: string, data = {}) =>
  process.send?.({ event, elapsedMs: Date.now() - started, ...data });
const app = Fastify();
app.log.error = (...args: unknown[]) =>
  emit("shutdown-error", {
    message: args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
  });
registerLlmProxyDrain(app, config.shutdown.drainSeconds * 1000);
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
// Import the real telemetry module: it must not own a process signal listener.
const { shutdownTelemetry } = await import("../observability/tracing/sdk");
const { default: mcpClient } = await import("../clients/mcp-client");
let dependencyClosed = false;
app.addHook("onClose", async () => {
  dependencyClosed = true;
  emit("dependency-closed");
});
app.get("/ready", async () => ({ ready: true }));
app.get("/health", async () => ({ healthy: true }));
app.addHook("onResponse", (request, _reply) => {
  if (request.routeOptions.url !== "/api/synthetic-mutation") return;
  const work = wait(200).then(() =>
    emit("audit-persisted", { dependencyClosed }),
  );
  trackBackgroundWork(work);
  return work;
});
app.post("/api/synthetic-mutation", async () => {
  emit("admitted", { route: "audit" });
  await wait(opts.durationMs);
  return { completed: true };
});
app.get("/v1/openai/json", async () => {
  emit("admitted", { route: "json" });
  await wait(opts.durationMs);
  emit("json-completed");
  return { completed: true };
});
app.get("/v1/openai/stream", async (_req, reply) => {
  emit("admitted", { route: "stream" });
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
  reply.raw.write("data: first\n\n");
  await wait(opts.durationMs);
  reply.raw.end("data: done\n\n");
  if (opts.persistMs) await wait(opts.persistMs);
  emit("stream-persisted", { dependencyClosed });
  if (opts.backgroundMs)
    trackBackgroundWork(
      wait(opts.backgroundMs).then(() =>
        emit("background-persisted", { dependencyClosed }),
      ),
    );
});
app.post("/v1/mcp/test", async (req, reply) => {
  const server = new McpServer({ name: "synthetic-ha-test", version: "1.0.0" });
  server.registerTool(
    "slow",
    { description: "Synthetic wait, no external effects" },
    async () => {
      emit("admitted", { route: "mcp" });
      await wait(opts.durationMs);
      emit("tool-completed");
      return { content: [{ type: "text", text: "completed" }] };
    },
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  reply.hijack();
  await transport.handleRequest(req.raw, reply.raw, req.body);
});

const stop = () => {};
const shutdown = async () => {};
const noopService = new Proxy({}, { get: () => stop });
const asyncService = new Proxy({}, { get: () => shutdown });
const source = readFileSync("src/server.ts", "utf8");
// Execute the production coordinator without booting live application services.
const functionSource = source.slice(
  source.indexOf("function registerWebServerShutdown("),
  source.indexOf("/**\n * Starts the process in worker-only mode."),
);
const js = ts.transpile(functionSource, { target: ts.ScriptTarget.ES2022 });
const context = {
  process,
  setTimeout,
  clearTimeout,
  clearInterval,
  beginLlmProxyDrain,
  drainLlmProxyRequests,
  drainBackgroundWork,
  shutdownTimeoutMs: () =>
    (Math.max(
      config.shutdown.drainSeconds,
      config.kb.taskWorkerShutdownTimeoutSeconds,
    ) +
      config.shutdown.cleanupSeconds) *
    1000,
  flushShutdownTelemetry: async () => {
    await shutdownTelemetry();
    emit("telemetry-flushed");
  },
  SHUTDOWN_CLEANUP_TIMEOUT_MS: 5000,
  activeChatRunService: asyncService,
  a2aTaskRunService: asyncService,
  agentRunReconciler: noopService,
  agentImagePrefetcher: noopService,
  agentWarmPoolManager: noopService,
  metricsServerInstance: undefined,
  publicEndpointsServerInstance: undefined,
  websocketService: noopService,
  mcpClient: {
    disconnectAll: async () => {
      await mcpClient.disconnectAll();
      emit("mcp-disconnected");
    },
  },
  cacheManager: { shutdown: () => emit("cache-closed") },
  posthogErrorTrackingService: asyncService,
  skillSandboxRuntimeService: asyncService,
  shouldRunWorker: false,
  taskQueueService: asyncService,
  mcpToolsRefreshManager: noopService,
  mcpImageUpdateChecker: noopService,
  mcpGatewayTaskReaper: noopService,
  instanceAnalyticsService: noopService,
  rumExporter: asyncService,
  metrics: { activeUsers: { activeUsersMetricCollector: noopService } },
  cleanupEmailProvider: shutdown,
  chatOpsManager: asyncService,
  ngrokTunnelManager: asyncService,
};
const register = vm.runInNewContext(
  `${js}\nregisterWebServerShutdown`,
  context,
);
register(app);
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.on("SIGTERM", () => emit("signal"));
emit("ready", { url });
