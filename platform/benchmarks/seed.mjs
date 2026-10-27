import { pathToFileURL } from "node:url";
import { MOCK_MCP_TOOL } from "./mock-upstream.mjs";
import { benchmarkPorts } from "./ports.mjs";

export async function createBenchmarkVirtualKey(portOffset) {
  const api = await signIn(portOffset);
  const { value } = await api("POST", "/api/llm-virtual-keys", {
    name: "Proxy benchmark",
    keyType: "passthrough",
  });
  if (typeof value !== "string" || !value)
    throw new Error("Benchmark virtual key creation returned no token");
  return value;
}

/** An MCP gateway exposing the mock's one tool, and a user token for it. */
export async function createBenchmarkMcpGateway(portOffset) {
  const api = await signIn(portOffset);
  const { mock } = benchmarkPorts(portOffset);
  const name = "benchmark-mcp";
  const catalog = await api("POST", "/api/internal_mcp_catalog", {
    name,
    serverType: "remote",
    serverUrl: `http://127.0.0.1:${mock}/mcp`,
  });
  const agent = await api("POST", "/api/agents", {
    name,
    agentType: "mcp_gateway",
    toolExposureMode: "full",
  });
  const server = await api("POST", "/api/mcp_server", {
    name,
    catalogId: catalog.id,
    scope: "personal",
    agentIds: [agent.id],
  });
  const tools = await api("GET", `/api/mcp_server/${server.id}/tools`);
  const tool = tools.find((candidate) =>
    candidate.name.endsWith(MOCK_MCP_TOOL),
  );
  if (!tool) throw new Error("Benchmark MCP tool was not discovered");
  if (!tool.assignedAgents?.some((assigned) => assigned.id === agent.id))
    await api("POST", "/api/agents/tools/bulk-assign", {
      assignments: [
        { agentId: agent.id, toolId: tool.id, mcpServerId: server.id },
      ],
    });
  await api("GET", "/api/user-tokens/me");
  const { value: token } = await api("GET", "/api/user-tokens/me/value");
  if (typeof token !== "string" || !token)
    throw new Error("Benchmark user token is unavailable");
  return { agentId: agent.id, tool: tool.name, token };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Captured into shell variables; never written to the measurements artifact.
  if (process.argv[3] === "mcp") {
    const { agentId, tool, token } = await createBenchmarkMcpGateway(
      process.argv[2],
    );
    // One line, newline-terminated, for the launcher's `read`.
    process.stdout.write(`${agentId} ${tool} ${token}\n`);
  } else {
    process.stdout.write(await createBenchmarkVirtualKey(process.argv[2]));
  }
}

async function signIn(portOffset) {
  const { backend } = benchmarkPorts(portOffset);
  const base = `http://127.0.0.1:${backend}`;
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:13000",
  };
  const login = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers,
    body: JSON.stringify({
      email: "admin@example.com",
      password: "local-benchmark-password",
    }),
  });
  if (!login.ok)
    throw new Error(`Benchmark sign-in failed: HTTP ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!cookie) throw new Error("Benchmark sign-in returned no session cookie");
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(30000),
      headers: { ...headers, cookie },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `Benchmark setup ${method} ${path}: HTTP ${response.status}`,
      );
    return response.json();
  };
}
