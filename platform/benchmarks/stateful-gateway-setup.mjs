import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureTools } from "./stateful-mcp-fixture.mjs";

export const FIXTURE_TOOL_COUNT = 128;

const NAMESPACE_PATTERN = /^[a-z0-9-]{8,40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const BULK_LIMIT = 5000;

export class SetupError extends Error {
  constructor(classification, status = null) {
    super(classification);
    this.name = "SetupError";
    this.classification = classification;
    this.status = status;
  }
}

export function catalogNameFor(namespace) {
  assertNamespace(namespace);
  return `bench-${namespace}`;
}

export function nameSchemaFor(namespace, rawToolNames) {
  const catalogName = catalogNameFor(namespace);
  const prefix = sanitizeServerName(catalogName);
  if (!prefix || prefix === "archestra" || prefix.length > 51) {
    throw new SetupError("guard");
  }
  const rawNames =
    rawToolNames ??
    fixtureTools({
      namespace,
      count: FIXTURE_TOOL_COUNT,
    }).map((tool) => tool.name);
  if (
    !Array.isArray(rawNames) ||
    rawNames.length < 1 ||
    rawNames.length > 256 ||
    new Set(rawNames).size !== rawNames.length ||
    rawNames.some(
      (name) =>
        typeof name !== "string" || !/^[a-z][a-z0-9_]{1,31}$/.test(name),
    )
  )
    throw new SetupError("guard");
  const names = rawNames.map((name) => `${prefix}__${name}`);
  if (names.some((name) => name.length > 64)) throw new SetupError("guard");
  return { catalogName, separator: "__", prefix, rawNames, names };
}

export function assertIsolatedTargets({ base, fixtureBase }) {
  return {
    admin: parseLoopback(base),
    fixture: parseLoopback(fixtureBase),
  };
}

export async function setup(api, options) {
  options.signal?.throwIfAborted();
  const schema = nameSchemaFor(options.namespace, options.rawToolNames);
  const targets = assertIsolatedTargets(options);
  const fixturePath = options.fixturePath ?? "/mcp";
  if (!/^\/mcp(?:\/[a-zA-Z0-9_-]+\/[a-z]+)?$/.test(fixturePath))
    throw new SetupError("guard");
  const fixtureUrl = new URL(fixturePath, targets.fixture).href;
  const created = {
    namespace: options.namespace,
    catalogName: schema.catalogName,
    catalogId: null,
    serverId: null,
    agentId: null,
    agentCreated: false,
    toolIds: [],
    sideEffectAgentIds: [],
    ownerId: null,
  };
  try {
    if (options.reuseAgentId) {
      if (!UUID_PATTERN.test(options.reuseAgentId)) {
        throw new SetupError("guard");
      }
      const agent = await readJson(
        api,
        "GET",
        `/api/agents/${options.reuseAgentId}`,
      );
      if (
        agent.id !== options.reuseAgentId ||
        agent.agentType !== "mcp_gateway" ||
        agent.toolExposureMode !== "full"
      ) {
        throw new SetupError("schema");
      }
      created.agentId = agent.id;
      created.ownerId = agent.authorId ?? null;
    }
    const catalog = await readJson(api, "POST", "/api/internal_mcp_catalog", {
      name: schema.catalogName,
      serverType: "remote",
      serverUrl: fixtureUrl,
    });
    if (
      catalog.name !== schema.catalogName ||
      catalog.serverType !== "remote" ||
      catalog.serverUrl !== fixtureUrl ||
      !UUID_PATTERN.test(catalog.id ?? "")
    ) {
      throw new SetupError("schema");
    }
    created.catalogId = catalog.id;
    created.ownerId = catalog.authorId ?? created.ownerId;
    if (!created.agentId) {
      const agent = await readJson(api, "POST", "/api/agents", {
        name: schema.catalogName,
        agentType: "mcp_gateway",
        toolExposureMode: "full",
      });
      if (
        agent.name !== schema.catalogName ||
        agent.agentType !== "mcp_gateway" ||
        agent.toolExposureMode !== "full" ||
        !UUID_PATTERN.test(agent.id ?? "")
      ) {
        throw new SetupError("schema");
      }
      created.agentId = agent.id;
      created.agentCreated = true;
      created.ownerId = created.ownerId ?? agent.authorId ?? null;
    }
    const server = await readJson(api, "POST", "/api/mcp_server", {
      name: schema.catalogName,
      catalogId: catalog.id,
      scope: "personal",
      agentIds: [created.agentId],
    });
    if (
      server.name !== schema.catalogName ||
      server.catalogId !== catalog.id ||
      server.localInstallationStatus === "error" ||
      !UUID_PATTERN.test(server.id ?? "")
    ) {
      throw new SetupError("schema");
    }
    created.serverId = server.id;
    let tools = await readJson(
      api,
      "GET",
      `/api/mcp_server/${server.id}/tools`,
    );
    assertFixtureTools(tools, schema);
    const missing = tools.filter((tool) => !assignedTo(tool, created.agentId));
    if (missing.length) {
      const assigned = await readJson(
        api,
        "POST",
        "/api/agents/tools/bulk-assign",
        {
          assignments: missing.map((tool) => ({
            agentId: created.agentId,
            toolId: tool.id,
            mcpServerId: server.id,
          })),
        },
      );
      if (assigned.failed?.length) throw new SetupError("tool_count");
      tools = await readJson(api, "GET", `/api/mcp_server/${server.id}/tools`);
      assertFixtureTools(tools, schema);
      if (tools.some((tool) => !assignedTo(tool, created.agentId))) {
        throw new SetupError("tool_count");
      }
    }
    const sideEffects = sideEffectAgents(tools, created.agentId);
    if (sideEffects.length) {
      await removeAssignments(
        api,
        sideEffects.flatMap((agentId) =>
          tools.map((tool) => ({ agentId, toolId: tool.id })),
        ),
      );
      created.sideEffectAgentIds = sideEffects;
    }
    created.toolIds = tools.map((tool) => tool.id);
    await readJson(api, "GET", "/api/user-tokens/me");
    const tokenBody = await readJson(api, "GET", "/api/user-tokens/me/value");
    const token = tokenBody.value;
    if (typeof token !== "string" || !token) throw new SetupError("schema");
    const listing = await gatewayToolsList({
      base: targets.admin,
      agentId: created.agentId,
      token,
      signal: options.signal,
    });
    const gatewayTools = projectGatewayTools(listing, schema);
    return {
      catalogId: created.catalogId,
      serverId: created.serverId,
      agentId: created.agentId,
      agentCreated: created.agentCreated,
      ownerId: created.ownerId,
      toolIds: created.toolIds,
      tools: gatewayTools,
      attested: gatewayTools.every((tool) =>
        tool.description.startsWith("[[gwa1."),
      ),
      nameSchema: {
        catalogName: schema.catalogName,
        separator: schema.separator,
        prefix: schema.prefix,
        count: schema.names.length,
        names: schema.names,
      },
      proof: proofOf(created),
    };
  } catch (error) {
    const classified = asSetupError(error);
    classified.proof = proofOf(created);
    throw classified;
  }
}

export async function cleanup(api, proof) {
  assertProof(proof);
  const name = catalogNameFor(proof.namespace);
  const catalog = proof.catalogId
    ? await owned(api, `/api/internal_mcp_catalog/${proof.catalogId}`, {
        id: proof.catalogId,
        name,
      })
    : null;
  const server = proof.serverId
    ? await owned(api, `/api/mcp_server/${proof.serverId}`, {
        id: proof.serverId,
        name,
        catalogId: proof.catalogId,
      })
    : null;
  const agent =
    proof.agentCreated && proof.agentId
      ? await owned(api, `/api/agents/${proof.agentId}`, {
          id: proof.agentId,
          name,
        })
      : null;
  const listed = server
    ? await readJson(api, "GET", `/api/mcp_server/${server.id}/tools`)
    : [];
  const allowed = new Set(proof.toolIds ?? []);
  const confirmed = (Array.isArray(listed) ? listed : []).filter(
    (tool) => allowed.has(tool.id) && typeof tool.id === "string",
  );
  const removals = [];
  for (const tool of confirmed) {
    for (const assigned of tool.assignedAgents ?? []) {
      const sideEffect = (proof.sideEffectAgentIds ?? []).includes(assigned.id);
      const createdAgent = proof.agentCreated && assigned.id === proof.agentId;
      if (sideEffect || createdAgent) {
        removals.push({ agentId: assigned.id, toolId: tool.id });
      }
    }
  }
  if (removals.length) await removeAssignments(api, removals);
  if (server) await readJson(api, "DELETE", `/api/mcp_server/${server.id}`);
  if (catalog) {
    await readJson(api, "DELETE", `/api/internal_mcp_catalog/${catalog.id}`);
  }
  if (agent) await readJson(api, "DELETE", `/api/agents/${agent.id}`);
  return {
    server: Boolean(server),
    catalog: Boolean(catalog),
    agent: Boolean(agent),
    unassigned: removals.length,
  };
}

export function safeSummary(result) {
  return {
    ready: true,
    catalogId: result.catalogId,
    serverId: result.serverId,
    agentId: result.agentId,
    agentCreated: result.agentCreated,
    ownerId: result.ownerId,
    toolCount: result.nameSchema.count,
    attested: result.attested,
    names: result.nameSchema.names,
  };
}

export async function writeIdArtifact(filePath, result) {
  const body = {
    catalogId: result.catalogId,
    serverId: result.serverId,
    agentId: result.agentId,
    agentCreated: result.agentCreated,
    ownerId: result.ownerId,
    toolIds: result.toolIds,
    nameSchema: {
      catalogName: result.nameSchema.catalogName,
      separator: result.nameSchema.separator,
      prefix: result.nameSchema.prefix,
      count: result.nameSchema.count,
      names: result.nameSchema.names,
    },
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

export function createAdminApi({ base, auth, signal }) {
  assertIsolatedTargets({ base, fixtureBase: "http://127.0.0.1" });
  if (typeof auth !== "string" || !auth) throw new SetupError("guard");
  return async (method, path, body) => {
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        authorization: auth,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(30000),
    });
    return readHttp(response);
  };
}

export async function runCli({ argv, env, log = () => {} }) {
  if (!argv.includes("--isolated-dev")) throw new SetupError("guard");
  const namespace = flag(argv, "--namespace");
  const base = flag(argv, "--base") ?? "http://127.0.0.1:9000";
  const fixtureBase = flag(argv, "--fixture-base") ?? "http://127.0.0.1:19101";
  const reuseAgentId = flag(argv, "--reuse-agent");
  const out = flag(argv, "--out");
  assertIsolatedTargets({ base, fixtureBase });
  nameSchemaFor(namespace);
  const auth = env.ARCHESTRA_BENCHMARK_API_AUTH;
  if (typeof auth !== "string" || !auth) throw new SetupError("guard");
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const api = createAdminApi({
    base,
    auth,
    signal: interrupted.signal,
  });
  try {
    const result = await setup(api, {
      base,
      fixtureBase,
      namespace,
      reuseAgentId,
      signal: interrupted.signal,
    });
    if (out) await writeIdArtifact(out, result);
    log(JSON.stringify(safeSummary(result)));
    return result;
  } catch (error) {
    const classified = asSetupError(error);
    if (classified.proof) {
      try {
        await cleanup(api, classified.proof);
      } catch {
        // The original classification stays authoritative.
      }
    }
    throw classified;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

function assertNamespace(namespace) {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw new SetupError("guard");
  }
}

function assertProof(proof) {
  if (!proof || typeof proof !== "object") throw new SetupError("ownership");
  assertNamespace(proof.namespace);
  for (const id of [proof.catalogId, proof.serverId, proof.agentId]) {
    if (id != null && !UUID_PATTERN.test(id)) throw new SetupError("ownership");
  }
}

function parseLoopback(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SetupError("guard");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new SetupError("guard");
  }
  return url;
}

function sanitizeServerName(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}

function proofOf(created) {
  return {
    namespace: created.namespace,
    catalogName: created.catalogName,
    catalogId: created.catalogId,
    serverId: created.serverId,
    agentId: created.agentId,
    agentCreated: created.agentCreated,
    toolIds: created.toolIds,
    sideEffectAgentIds: created.sideEffectAgentIds,
    ownerId: created.ownerId,
  };
}

function assignedTo(tool, agentId) {
  return (tool.assignedAgents ?? []).some((agent) => agent.id === agentId);
}

function sideEffectAgents(tools, agentId) {
  return [
    ...new Set(
      tools.flatMap((tool) =>
        (tool.assignedAgents ?? [])
          .map((agent) => agent.id)
          .filter((id) => id && id !== agentId),
      ),
    ),
  ];
}

function assertFixtureTools(tools, schema) {
  if (!Array.isArray(tools) || tools.length !== schema.names.length) {
    throw new SetupError("tool_count");
  }
  const names = new Set(tools.map((tool) => tool.name));
  if (
    schema.names.some((name) => !names.has(name)) ||
    tools.some((tool) => typeof tool.id !== "string" || !tool.id)
  ) {
    throw new SetupError("tool_count");
  }
}

function projectGatewayTools(listing, schema) {
  const tools = listing?.result?.tools;
  if (!Array.isArray(tools)) throw new SetupError("schema");
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const projected = schema.names.map((name) => {
    const tool = byName.get(name);
    if (!tool || tool.name !== name) throw new SetupError("tool_count");
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema ?? null,
    };
  });
  if (projected.length !== schema.names.length)
    throw new SetupError("tool_count");
  return projected;
}

async function gatewayToolsList({ base, agentId, token, signal }) {
  let response;
  try {
    response = await fetch(new URL(`/v1/mcp/${agentId}`, base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw asSetupError(error);
  }
  const listing = await readHttp(response);
  if (listing.error) throw new SetupError("upstream");
  return listing;
}

async function readHttp(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SetupError(statusClass(response.status), response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new SetupError("schema", response.status);
  }
}

async function readJson(api, method, path, body) {
  try {
    const response = await api(method, path, body);
    if (!response || typeof response !== "object") {
      throw new SetupError("schema");
    }
    return response;
  } catch (error) {
    throw asSetupError(error);
  }
}

async function owned(api, path, expected) {
  try {
    const row = await readJson(api, "GET", path);
    for (const [key, value] of Object.entries(expected)) {
      if (row[key] !== value) throw new SetupError("ownership");
    }
    return row;
  } catch (error) {
    const classified = asSetupError(error);
    if (classified.classification === "not_found") return null;
    throw classified;
  }
}

async function removeAssignments(api, pairs) {
  for (let index = 0; index < pairs.length; index += BULK_LIMIT) {
    await readJson(api, "POST", "/api/agents/tools/bulk-update", {
      assignments: [],
      removals: pairs.slice(index, index + BULK_LIMIT),
    });
  }
}

function statusClass(status) {
  if (status === 400) return "rejected";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 502) return "upstream";
  return `http_${status}`;
}

function asSetupError(error) {
  if (error instanceof SetupError) return error;
  if (error?.name === "AbortError") return new SetupError("aborted");
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return new SetupError(statusClass(status), status);
  }
  return new SetupError("unavailable");
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new SetupError("guard");
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli({
    argv: process.argv.slice(2),
    env: process.env,
    log: (line) => console.info(line),
  }).catch((error) => {
    const classified = asSetupError(error);
    console.error(
      JSON.stringify({
        ready: false,
        classification: classified.classification,
        status: classified.status,
      }),
    );
    process.exitCode = 1;
  });
}
