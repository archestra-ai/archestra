import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { ArchestraContext } from "@/archestra-mcp-server/types";
import db, { schema } from "@/database";
import { A2aConnectionModel, A2aRemoteAgentModel, ToolModel } from "@/models";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { expect, test } from "@/test";
import type { A2aConnectionAuthInput } from "@/types";
import { isAllowedA2aAddress } from "@/utils/outbound-url";
import { executeOutboundA2aDelegation } from "./a2a-outbound-client";

type OutboundA2aTarget = Parameters<
  typeof executeOutboundA2aDelegation
>[0]["target"];

// Keep the dependency-free fixture as plain JavaScript while avoiding a
// production declaration solely for a test helper.
const fixtureModuleUrl = new URL(
  "../../../e2e-tests/fixtures/a2a-test-agent/server.mjs",
  import.meta.url,
).href;
const a2aFixture = (await import(fixtureModuleUrl)) as {
  createA2aFixtureServer: (options: { authMode: string }) => Server;
  DEFAULT_API_KEY: string;
  DEFAULT_BEARER_TOKEN: string;
};
const { createA2aFixtureServer, DEFAULT_API_KEY, DEFAULT_BEARER_TOKEN } =
  a2aFixture;

test("allows only public unicast addresses plus loopback in local development", () => {
  expect(isAllowedA2aAddress("8.8.8.8")).toBe(true);
  expect(isAllowedA2aAddress("2001:4860:4860::8888")).toBe(true);
  expect(isAllowedA2aAddress("127.0.0.1")).toBe(true);
  expect(isAllowedA2aAddress("10.0.0.1")).toBe(false);
  expect(isAllowedA2aAddress("169.254.169.254")).toBe(false);
  expect(isAllowedA2aAddress("100.64.0.1")).toBe(false);
  expect(isAllowedA2aAddress("224.0.0.1")).toBe(false);
  expect(isAllowedA2aAddress("::")).toBe(false);
});

test("returns text and structured data through the real A2A SDK", async ({
  makeAgent,
  makeOrganization,
}) => {
  await withFixture({ authMode: "none" }, async ({ baseUrl }) => {
    const organization = await makeOrganization();
    const parent = await makeAgent({
      name: "Outbound parent",
      organizationId: organization.id,
    });
    const target = await createTarget({
      baseUrl,
      organizationId: organization.id,
      auth: { type: "none" },
    });
    const context = makeContext({ parent, organizationId: organization.id });

    const immediate = await executeOutboundA2aDelegation({
      target,
      message: "[fixture:immediate] hello",
      context,
    });
    const artifact = await executeOutboundA2aDelegation({
      target,
      message: "[fixture:artifact] structured payload",
      context,
    });

    expect(immediate).toBe("Fixture response: hello");
    expect(artifact).toContain("Fixture response: structured payload");
    expect(artifact).toContain(
      JSON.stringify({ fixture: true, input: "structured payload" }),
    );

    const runs = await db
      .select()
      .from(schema.a2aOutboundRunsTable)
      .where(
        eq(schema.a2aOutboundRunsTable.connectionId, target.connection.id),
      );
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.state)).toEqual(["completed", "completed"]);
    const taskRun = runs.find((run) => run.remoteTaskId !== null);
    expect(taskRun).toMatchObject({
      remoteTaskId: "00000000-0000-4000-8000-000000000001",
      remoteContextId: "10000000-0000-4000-8000-000000000001",
      statusReason: null,
    });
    expect(runs.every((run) => run.completedAt instanceof Date)).toBe(true);
  });
});

test("authenticates SDK requests with bearer and API-key credentials", async ({
  makeAgent,
  makeOrganization,
}) => {
  for (const scenario of [
    {
      label: "bearer",
      fixtureAuthMode: "bearer",
      auth: {
        type: "bearer",
        credential: DEFAULT_BEARER_TOKEN,
      } satisfies A2aConnectionAuthInput,
    },
    {
      label: "API key",
      fixtureAuthMode: "api-key",
      auth: {
        type: "api_key",
        headerName: "X-API-Key",
        credential: DEFAULT_API_KEY,
      } satisfies A2aConnectionAuthInput,
    },
  ]) {
    await withFixture(
      { authMode: scenario.fixtureAuthMode },
      async ({ baseUrl, journal }) => {
        const organization = await makeOrganization();
        const parent = await makeAgent({
          name: `Authenticated ${scenario.label} parent`,
          organizationId: organization.id,
        });
        const target = await createTarget({
          baseUrl,
          organizationId: organization.id,
          auth: scenario.auth,
        });

        const result = await executeOutboundA2aDelegation({
          target,
          message: "[fixture:immediate] authenticated",
          context: makeContext({ parent, organizationId: organization.id }),
        });

        expect(result).toBe("Fixture response: authenticated");
        const rpcRequest = (await journal()).requests.find(
          (request) => request.path === "/a2a",
        );
        expect(
          rpcRequest?.headers.authorization ?? rpcRequest?.headers["x-api-key"],
        ).toBe("[REDACTED]");
      },
    );
  }
});

test("persists failed remote task state and identifiers", async ({
  makeAgent,
  makeOrganization,
}) => {
  await withFixture({ authMode: "none" }, async ({ baseUrl }) => {
    const organization = await makeOrganization();
    const parent = await makeAgent({
      name: "Failure parent",
      organizationId: organization.id,
    });
    const target = await createTarget({
      baseUrl,
      organizationId: organization.id,
      auth: { type: "none" },
    });

    await expect(
      executeOutboundA2aDelegation({
        target,
        message: "[fixture:failed] remote failure detail",
        context: makeContext({ parent, organizationId: organization.id }),
      }),
    ).rejects.toThrow("Fixture response: remote failure detail");

    const [run] = await db
      .select()
      .from(schema.a2aOutboundRunsTable)
      .where(
        eq(schema.a2aOutboundRunsTable.connectionId, target.connection.id),
      );
    expect(run).toMatchObject({
      state: "failed",
      remoteTaskId: "00000000-0000-4000-8000-000000000001",
      remoteContextId: "10000000-0000-4000-8000-000000000001",
      errorCode: "remote_failed",
      statusReason: "Fixture response: remote failure detail",
    });
    expect(run.completedAt).toBeInstanceOf(Date);
  });
});

test("sends only the explicit delegation message across the A2A boundary", async ({
  makeAgent,
  makeOrganization,
}) => {
  await withFixture({ authMode: "none" }, async ({ baseUrl, journal }) => {
    const organization = await makeOrganization();
    const parent = await makeAgent({
      name: "DO_NOT_SEND_AGENT_NAME",
      organizationId: organization.id,
    });
    const target = await createTarget({
      baseUrl,
      organizationId: organization.id,
      auth: { type: "none" },
    });
    const explicitMessage = "[fixture:immediate] allowed payload";

    await executeOutboundA2aDelegation({
      target,
      message: explicitMessage,
      context: {
        ...makeContext({ parent, organizationId: organization.id }),
        sessionId: "DO_NOT_SEND_SESSION",
        delegationChain: "DO_NOT_SEND_DELEGATION_HISTORY",
        currentToolCallId: "DO_NOT_SEND_PARENT_TOOL_CALL",
      },
    });

    const rpcRequest = (await journal()).requests.find(
      (request) => request.path === "/a2a",
    );
    const wireBody = JSON.stringify(rpcRequest?.body);
    const parts = rpcRequest?.body?.params?.message?.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      text: explicitMessage,
    });
    expect(wireBody).not.toContain("DO_NOT_SEND_AGENT_NAME");
    expect(wireBody).not.toContain("DO_NOT_SEND_SESSION");
    expect(wireBody).not.toContain("DO_NOT_SEND_DELEGATION_HISTORY");
    expect(wireBody).not.toContain("DO_NOT_SEND_PARENT_TOOL_CALL");
    expect(rpcRequest?.body?.params?.message).not.toHaveProperty("history");
    expect(rpcRequest?.body?.params?.message).not.toHaveProperty(
      "systemPrompt",
    );
  });
});

type FixtureJournal = {
  requests: Array<{
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body?: {
      params?: {
        message?: {
          parts?: Array<Record<string, unknown>>;
          history?: unknown;
          systemPrompt?: unknown;
        };
      };
    };
  }>;
};

async function withFixture(
  options: { authMode: string },
  run: (fixture: {
    baseUrl: string;
    journal: () => Promise<FixtureJournal>;
  }) => Promise<void>,
): Promise<void> {
  const server = createA2aFixtureServer(options) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({
      baseUrl,
      journal: () =>
        fetch(`${baseUrl}/journal`).then(
          (response) => response.json() as Promise<FixtureJournal>,
        ),
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function createTarget(params: {
  baseUrl: string;
  organizationId: string;
  auth: A2aConnectionAuthInput;
}): Promise<OutboundA2aTarget> {
  const created = await createA2aRemoteAgent({
    organizationId: params.organizationId,
    input: {
      source: { type: "well_known", url: params.baseUrl },
      auth: params.auth,
      connectionName: "Default",
    },
  });
  const stored = await A2aRemoteAgentModel.findByIdForOrganization({
    id: created.id,
    organizationId: params.organizationId,
  });
  if (!stored) throw new Error("expected stored outbound A2A target");
  const [target] = await A2aConnectionModel.findTargetsByIdsForOrganization({
    ids: [stored.connection.id],
    organizationId: params.organizationId,
  });
  if (!target) throw new Error("expected executable outbound A2A target");
  const tool = await ToolModel.findById(stored.toolId);
  if (!tool) throw new Error("expected synthetic outbound A2A tool");
  return { ...target, tool };
}

function makeContext(params: {
  parent: { id: string; name: string };
  organizationId: string;
}): ArchestraContext {
  return {
    agent: params.parent,
    agentId: params.parent.id,
    organizationId: params.organizationId,
  };
}
