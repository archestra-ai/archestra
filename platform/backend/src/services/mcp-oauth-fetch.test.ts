import { lookup } from "node:dns/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { vi } from "vitest";
import config from "@/config";
import logger from "@/logging";
import EnvironmentModel from "@/models/environment";
import OrganizationModel from "@/models/organization";
import { afterEach, beforeEach, expect, test } from "@/test";
import { createMcpOAuthFetch, McpOAuthOutboundError } from "./mcp-oauth-fetch";

// Only DNS is faked: HTTP, dispatcher connections, bodies and redirects are real.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("@/logging");
const servers: Server[] = [];

beforeEach(() => {
  config.mcpOAuth.enforceOutboundValidation = true;
  config.production = false;
  config.test.enableE2eTestEndpoints = false;
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([
    { address: "127.0.0.1", family: 4 },
  ] as never);
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("compatibility delegates unchanged without reading even invalid context or resolving DNS", async () => {
  config.mcpOAuth.enforceOutboundValidation = false;
  config.production = true;
  const fetchMock = vi.fn().mockResolvedValue(new Response("legacy"));
  vi.stubGlobal("fetch", fetchMock);
  const guarded = createMcpOAuthFetch({
    get catalog(): never {
      throw new Error("must not read context");
    },
  });
  const init = {
    method: "POST",
    body: "client_secret=synthetic",
    redirect: "follow" as const,
  };
  expect(guarded).toBe(fetchMock);
  await guarded("http://10.0.0.1/token", init);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    "http://10.0.0.1/token",
    init,
  );
  expect(lookup).not.toHaveBeenCalled();
});

test("compatibility preserves real HTTP loopback POST redirects and credentials in production", async () => {
  config.mcpOAuth.enforceOutboundValidation = false;
  config.production = true;
  let received = "";
  const base = await serve(async (req, res) => {
    if (req.url === "/token") {
      res.writeHead(307, { location: "/canary" }).end();
      return;
    }
    for await (const chunk of req) received += chunk;
    res.end('{"access_token":"legacy-token"}');
  });
  const response = await createMcpOAuthFetch()(`${base}/token`, {
    method: "POST",
    body: "client_secret=synthetic",
  });
  expect(await response.json()).toEqual({ access_token: "legacy-token" });
  expect(received).toBe("client_secret=synthetic");
  expect(lookup).not.toHaveBeenCalled();
});

test("refusal diagnostics include the hostname without URL credentials or query secrets", async () => {
  config.production = true;
  await expect(
    createMcpOAuthFetch()(
      "https://user:synthetic-url-secret@provider.example/token?code=synthetic-code-secret",
    ),
  ).rejects.toBeInstanceOf(McpOAuthOutboundError);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      hostname: "provider.example",
      reason: expect.stringContaining("outbound request refused"),
    },
    "MCP OAuth outbound request refused",
  );
  const diagnostics = JSON.stringify(vi.mocked(logger.warn).mock.calls);
  expect(diagnostics).not.toContain("synthetic-url-secret");
  expect(diagnostics).not.toContain("synthetic-code-secret");
  expect(lookup).not.toHaveBeenCalled();
});

test.for([
  "http://public.example/token",
  "https://user:synthetic@public.example/token",
  "https://127.0.0.1/token",
  "https://10.0.0.1/token",
  "https://169.254.169.254/token",
  "https://[::ffff:127.0.0.1]/token",
])("production rejects literal destination %s before HTTP", async (url, {
  makeInternalMcpCatalog,
}) => {
  config.production = true;
  const catalog = await makeInternalMcpCatalog();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(createMcpOAuthFetch({ catalog })(url)).rejects.toBeInstanceOf(
    McpOAuthOutboundError,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test.for([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "100.64.0.1",
  "224.0.0.1",
  "::",
  "::ffff:10.0.0.1",
  "fc00::1",
])("rejects private/reserved DNS answer %s including mixed answers", async (address, {
  makeInternalMcpCatalog,
}) => {
  config.production = true;
  const catalog = await makeInternalMcpCatalog();
  vi.mocked(lookup).mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address, family: address.includes(":") ? 6 : 4 },
  ] as never);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    createMcpOAuthFetch({ catalog })("https://public.example/token"),
  ).rejects.toThrow("private_or_loopback_host");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("pins one DNS answer for the real connection and preserves original Host", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  let host = "";
  const base = await serve((req, res) => {
    host = req.headers.host ?? "";
    res.end("ok");
  });
  vi.mocked(lookup)
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never)
    .mockResolvedValue([{ address: "10.0.0.1", family: 4 }] as never);
  const url = base.replace("127.0.0.1", "pin.example");
  expect(await (await createMcpOAuthFetch({ catalog })(url)).text()).toBe("ok");
  expect(host).toBe(new URL(url).host);
  expect(lookup).toHaveBeenCalledTimes(1);
});

test.for([
  "remote",
  "local",
] as const)("denies a public HTTPS OAuth destination by %s catalog environment", async (serverType, {
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  config.production = true;
  const org = await makeOrganization();
  const environment = await EnvironmentModel.create({
    organizationId: org.id,
    name: "restricted",
    networkPolicy: {
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: ["allowed.example"],
      allowedCidrs: [],
    },
  });
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: environment.id,
    serverType,
    serverUrl: "https://allowed.example/mcp",
  });
  await expect(
    createMcpOAuthFetch({ catalog })("https://denied.example/token", {
      method: "POST",
      body: "synthetic-secret",
    }),
  ).rejects.toThrow("environment policy denies destination");
  expect(lookup).not.toHaveBeenCalled();
});

test("checks remote base policy before OAuth, even when OAuth host is allowed", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  await OrganizationModel.patch(org.id, {
    defaultNetworkPolicy: {
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: ["oauth.example"],
      allowedCidrs: [],
    },
  });
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    serverType: "remote",
    serverUrl: "https://denied.example/mcp",
  });
  await expect(
    createMcpOAuthFetch({ catalog })("https://oauth.example/token"),
  ).rejects.toThrow("denies MCP server");
  expect(lookup).not.toHaveBeenCalled();
});

test("rejects missing and foreign context instead of inheriting unrestricted defaults", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  const foreign = await makeOrganization();
  const env = await EnvironmentModel.create({
    organizationId: foreign.id,
    name: "foreign",
  });
  for (const context of [
    undefined,
    { catalog, organizationId: foreign.id },
    { catalog: { ...catalog, environmentId: env.id } },
    { catalog: { ...catalog, environmentId: crypto.randomUUID() } },
    { catalog: { ...catalog, organizationId: null } },
  ]) {
    await expect(
      createMcpOAuthFetch(context)("https://public.example/token"),
    ).rejects.toBeInstanceOf(McpOAuthOutboundError);
  }
  expect(lookup).not.toHaveBeenCalled();
});

test.for([
  301, 302, 303, 307, 308,
])("rejects POST redirect %s without delivering secrets to canary", async (status, {
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  let canary = 0;
  const base = await serve((req, res) => {
    if (req.url === "/canary") {
      canary++;
      res.end("bad");
    } else res.writeHead(status, { location: "/canary" }).end();
  });
  await expect(
    createMcpOAuthFetch({ catalog })(`${base}/token`, {
      method: "POST",
      body: "client_secret=synthetic",
      redirect: "follow",
      dispatcher: {},
    } as RequestInit),
  ).rejects.toThrow("redirects are disabled");
  expect(canary).toBe(0);
});

test("metadata redirects revalidate each destination and never reach denied canary", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  await OrganizationModel.patch(org.id, {
    defaultNetworkPolicy: {
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: ["allowed.example"],
      allowedCidrs: [],
    },
  });
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    serverType: "local",
  });
  let canary = 0;
  const base = await serve((req, res) => {
    if (req.url === "/canary") {
      canary++;
      res.end("bad");
    } else res.writeHead(302, { location: `${base}/canary` }).end();
  });
  await expect(
    createMcpOAuthFetch({ catalog })(
      base.replace("127.0.0.1", "allowed.example"),
    ),
  ).rejects.toThrow("environment policy denies destination");
  expect(canary).toBe(0);
  expect(lookup).toHaveBeenCalledTimes(1);
});

test("allows bounded metadata redirects and stops cycles", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  let requests = 0;
  const base = await serve((req, res) => {
    requests++;
    if (req.url === "/ok") res.end("metadata");
    else
      res
        .writeHead(302, { location: req.url === "/start" ? "/ok" : "/loop" })
        .end();
  });
  expect(
    await (await createMcpOAuthFetch({ catalog })(`${base}/start`)).text(),
  ).toBe("metadata");
  requests = 0;
  await expect(
    createMcpOAuthFetch({ catalog })(`${base}/loop`),
  ).rejects.toThrow("too many redirects");
  expect(requests).toBe(4);
});

test("bounds streamed responses and releases sockets after failure and success", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  const base = await serve((req, res) => {
    res.end(req.url === "/large" ? "x".repeat(1024 * 1024 + 1) : "ok");
  });
  await expect(
    createMcpOAuthFetch({ catalog })(`${base}/large`),
  ).rejects.toThrow("response too large");
  expect(await (await createMcpOAuthFetch({ catalog })(base)).text()).toBe(
    "ok",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise<void>((resolve, reject) =>
    servers.at(-1)?.getConnections((error, count) => {
      if (error) reject(error);
      else {
        expect(count).toBe(0);
        resolve();
      }
    }),
  );
});

test("caller cancellation interrupts response streaming without poisoning later requests", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  const controller = new AbortController();
  const base = await serve((req, res) => {
    if (req.url === "/ok") {
      res.end("ok");
      return;
    }
    res.writeHead(200);
    res.write("partial");
    setTimeout(() => controller.abort(), 10);
  });
  const guarded = createMcpOAuthFetch({ catalog });
  await expect(guarded(base, { signal: controller.signal })).rejects.toThrow(
    "canceled or timed out",
  );
  expect(await (await guarded(`${base}/ok`)).text()).toBe("ok");
  expect(lookup).toHaveBeenCalledTimes(2);
});

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("global catalogs use authorized request or installation-derived organization policy", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeMcpServer,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const team = await makeTeam(org.id, user.id);
  const catalog = await makeInternalMcpCatalog({ organizationId: null });
  const owned = await makeMcpServer({
    catalogId: catalog.id,
    ownerId: user.id,
  });
  const shared = await makeMcpServer({
    catalogId: catalog.id,
    teamId: team.id,
  });
  const base = await serve((_req, res) => res.end("allowed"));
  for (const context of [
    { catalog, organizationId: org.id },
    { catalog, installationId: owned.id },
    { catalog, installationId: shared.id },
  ]) {
    expect(await (await createMcpOAuthFetch(context)(base)).text()).toBe(
      "allowed",
    );
  }
  const otherOrg = await makeOrganization();
  await makeMember(user.id, otherOrg.id);
  await expect(
    createMcpOAuthFetch({ catalog, installationId: owned.id })(base),
  ).rejects.toThrow(
    "installation owner belongs to multiple organizations; explicit organization context required",
  );
  expect(
    await (
      await createMcpOAuthFetch({
        catalog,
        installationId: owned.id,
        organizationId: org.id,
      })(base)
    ).text(),
  ).toBe("allowed");
  await OrganizationModel.patch(org.id, {
    defaultNetworkPolicy: {
      egressMode: "off",
      domainPreset: "none",
      allowedDomains: [],
      allowedCidrs: [],
    },
  });
  await expect(
    createMcpOAuthFetch({
      catalog,
      installationId: owned.id,
      organizationId: org.id,
    })(base),
  ).rejects.toThrow("environment policy");
});

test("installation context must match both catalog and organization", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeMcpServer,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  const foreign = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, foreign.id);
  const catalog = await makeInternalMcpCatalog({ organizationId: null });
  const other = await makeInternalMcpCatalog({ organizationId: org.id });
  const server = await makeMcpServer({
    catalogId: catalog.id,
    ownerId: user.id,
  });
  await expect(
    createMcpOAuthFetch({ catalog: other, installationId: server.id })(
      "https://public.example",
    ),
  ).rejects.toThrow("installation context mismatch");
  await expect(
    createMcpOAuthFetch({
      catalog,
      organizationId: org.id,
      installationId: server.id,
    })("https://public.example"),
  ).rejects.toThrow("missing installation organization");
  expect(lookup).not.toHaveBeenCalled();
});

test("a security refusal poisons fallback attempts even when next URL is allowed", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  const guarded = createMcpOAuthFetch({ catalog });
  await expect(guarded("https://10.0.0.1")).rejects.toBeInstanceOf(
    McpOAuthOutboundError,
  );
  await expect(guarded("https://public.example")).rejects.toBeInstanceOf(
    McpOAuthOutboundError,
  );
  expect(lookup).not.toHaveBeenCalled();
});

test.for([204, 205, 304])("preserves bodyless status %s", async (status, {
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  const base = await serve((_req, res) => res.writeHead(status).end());
  const response = await createMcpOAuthFetch({ catalog })(base);
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("");
});

test("deadline covers DNS and destroys late pinned dispatchers without making a request", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  let resolveDns!: (value: never) => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  vi.mocked(lookup).mockImplementation(() => {
    lookupStarted();
    return new Promise((resolve) => {
      resolveDns = resolve;
    });
  });
  const destroy = vi.spyOn(Agent.prototype, "destroy");
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = createMcpOAuthFetch({ catalog })(
      "https://public.example",
    ).catch((error) => error);
    await started;
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await pending;
    expect(error.name).toBe("TimeoutError");
    expect(error).not.toBeInstanceOf(McpOAuthOutboundError);
    resolveDns([{ address: "8.8.8.8", family: 4 }] as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const destroyedAgents = [...new Set(destroy.mock.instances)];
    expect(destroyedAgents).toHaveLength(1);
    const agent = destroyedAgents[0];
    if (!(agent instanceof Agent)) throw new Error("Expected a pinned Agent");
    expect(agent.destroyed).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    destroy.mockRestore();
  }
});

test("malformed JSON does not leak response body through decoder errors", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog();
  const base = await serve((_req, res) => res.end("synthetic-secret-not-json"));
  const response = await createMcpOAuthFetch({ catalog })(base);
  await expect(response.json()).rejects.toThrow(
    "MCP OAuth response is not valid JSON",
  );
});
