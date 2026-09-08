import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { ToolModel, TrustedDataPolicyModel } from "@/models";
import { syncA2aDelegations } from "@/services/a2a-outbound-assignments";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { expect, test } from "@/test";
import { executeArchestraTool } from ".";

// Keep the dependency-free fixture as plain JavaScript while avoiding a
// production declaration solely for a test helper.
const fixtureModuleUrl = new URL(
  "../../../e2e-tests/fixtures/a2a-test-agent/server.mjs",
  import.meta.url,
).href;
const { createA2aFixtureServer } = (await import(fixtureModuleUrl)) as {
  createA2aFixtureServer: (options: { authMode: string }) => Server;
};

test("blocks an outbound A2A delegation with the exact synthetic tool policy before network dispatch", async ({
  makeAgent,
  makeOrganization,
  makeToolPolicy,
}) => {
  await withFixture(async ({ baseUrl, journal }) => {
    const organization = await makeOrganization();
    const parent = await makeAgent({
      name: "Policy parent",
      organizationId: organization.id,
    });
    const remote = await createA2aRemoteAgent({
      organizationId: organization.id,
      input: {
        source: {
          type: "inline_card",
          agentCard: makeAgentCard(baseUrl),
        },
        auth: { type: "none" },
        connectionName: "Default",
      },
    });
    await syncA2aDelegations({
      agentId: parent.id,
      organizationId: organization.id,
      connectionIds: [remote.connection.id],
    });
    const tool = await ToolModel.findById(remote.toolId);
    if (!tool) throw new Error("expected synthetic outbound A2A tool");
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "External classified-data transfer blocked",
      conditions: [],
    });

    const result = await executeArchestraTool(
      tool.name,
      { message: "classified" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        contextIsTrusted: true,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "External classified-data transfer blocked",
      ),
    });
    const policyError = (
      result.structuredContent as {
        archestraError?: Record<string, unknown>;
      }
    )?.archestraError;
    expect(policyError).toMatchObject({
      type: "policy_denied",
      toolName: tool.name,
      toolId: tool.id,
      input: { message: "classified" },
    });
    expect((await journal()).requests).toEqual([]);

    const runs = await db
      .select({ id: schema.a2aOutboundRunsTable.id })
      .from(schema.a2aOutboundRunsTable)
      .where(
        eq(schema.a2aOutboundRunsTable.connectionId, remote.connection.id),
      );
    expect(runs).toEqual([]);
  });
});

test("classifies same-named outbound results by exact synthetic tool", async ({
  makeOrganization,
}) => {
  const organization = await makeOrganization();
  const first = await createA2aRemoteAgent({
    organizationId: organization.id,
    input: {
      name: "Shared External",
      source: {
        type: "inline_card",
        agentCard: makeAgentCard("https://first.example.com"),
      },
      auth: { type: "none" },
      connectionName: "Default",
    },
  });
  const second = await createA2aRemoteAgent({
    organizationId: organization.id,
    input: {
      name: "shared-external",
      source: {
        type: "inline_card",
        agentCard: makeAgentCard("https://second.example.com"),
      },
      auth: { type: "none" },
      connectionName: "Default",
    },
  });
  await db
    .update(schema.trustedDataPoliciesTable)
    .set({ action: "mark_as_trusted" })
    .where(eq(schema.trustedDataPoliciesTable.toolId, first.toolId));
  const firstTool = await ToolModel.findById(first.toolId);
  if (!firstTool) throw new Error("expected first synthetic tool");
  await db
    .update(schema.toolsTable)
    .set({ name: firstTool.name })
    .where(eq(schema.toolsTable.id, second.toolId));

  const context = { teamIds: [], externalAgentId: "test" };
  const firstResult = await TrustedDataPolicyModel.evaluate(
    "unused",
    firstTool.name,
    "output",
    context,
    first.toolId,
  );
  const secondResult = await TrustedDataPolicyModel.evaluate(
    "unused",
    firstTool.name,
    "output",
    context,
    second.toolId,
  );

  expect(firstResult.isTrusted).toBe(true);
  expect(secondResult.isTrusted).toBe(false);
});

test("stamps guardrail defaults from the owning organization", async ({
  makeOrganization,
}) => {
  const organization = await makeOrganization({
    defaultDiscoveredToolInvocationPolicy: "allow_when_context_is_untrusted",
    defaultDiscoveredToolResultPolicy: "mark_as_trusted",
  });
  const remote = await createA2aRemoteAgent({
    organizationId: organization.id,
    input: {
      name: "Organization Defaults",
      source: {
        type: "inline_card",
        agentCard: makeAgentCard("https://defaults.example.com"),
      },
      auth: { type: "none" },
      connectionName: "Default",
    },
  });

  const [invocationPolicy] = await db
    .select({ action: schema.toolInvocationPoliciesTable.action })
    .from(schema.toolInvocationPoliciesTable)
    .where(eq(schema.toolInvocationPoliciesTable.toolId, remote.toolId));
  const [resultPolicy] = await db
    .select({ action: schema.trustedDataPoliciesTable.action })
    .from(schema.trustedDataPoliciesTable)
    .where(eq(schema.trustedDataPoliciesTable.toolId, remote.toolId));

  expect(invocationPolicy.action).toBe("allow_when_context_is_untrusted");
  expect(resultPolicy.action).toBe("mark_as_trusted");
});

function makeAgentCard(baseUrl: string) {
  return {
    name: "Policy Fixture Agent",
    description: "External target used to verify outbound policy enforcement.",
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: { streaming: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
}

async function withFixture(
  run: (fixture: {
    baseUrl: string;
    journal: () => Promise<{ requests: unknown[] }>;
  }) => Promise<void>,
): Promise<void> {
  const server = createA2aFixtureServer({ authMode: "none" }) as Server;
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
          (response) => response.json() as Promise<{ requests: unknown[] }>,
        ),
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
