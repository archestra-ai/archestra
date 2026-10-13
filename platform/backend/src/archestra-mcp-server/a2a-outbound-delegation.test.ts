import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MEMBER_ROLE_NAME } from "@archestra/shared";
import { ToolModel } from "@/models";
import { syncA2aDelegations } from "@/services/a2a-outbound-assignments";
import { createA2aRemoteAgent } from "@/services/a2a-outbound-registry";
import { expect, test } from "@/test";
// Load the tool registry first, as production does: importing `./delegation`
// directly would enter its import cycle through the registry half-initialized.
import ".";
import { getAgentTools, handleDelegation } from "./delegation";

// Keep the dependency-free fixture as plain JavaScript while avoiding a
// production declaration solely for a test helper.
const fixtureModuleUrl = new URL(
  "../../../e2e-tests/fixtures/a2a-test-agent/server.mjs",
  import.meta.url,
).href;
const { createA2aFixtureServer } = (await import(fixtureModuleUrl)) as {
  createA2aFixtureServer: (options: { authMode: string }) => Server;
};

test("hides and rejects an inaccessible external target for a real user while preserving headless execution", async ({
  makeAgent,
  makeMember,
  makeOrganization,
  makeUser,
}) => {
  await withFixture(async ({ baseUrl, journal }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const viewer = await makeUser();
    await makeMember(owner.id, organization.id);
    // Not an administrator: administrators hold Full access on every
    // external agent through the organization-wide grant.
    await makeMember(viewer.id, organization.id, { role: MEMBER_ROLE_NAME });
    const parent = await makeAgent({
      name: "Visibility parent",
      organizationId: organization.id,
    });
    const remote = await createA2aRemoteAgent({
      organizationId: organization.id,
      authorId: owner.id,
      input: {
        source: { type: "inline_card", agentCard: makeAgentCard(baseUrl) },
        auth: { type: "none" },
      },
    });
    await syncA2aDelegations({
      agentId: parent.id,
      organizationId: organization.id,
      connectionIds: [remote.connection.id],
    });
    const tool = await ToolModel.findById(remote.toolId);
    if (!tool) throw new Error("expected synthetic outbound A2A tool");

    const advertised = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: viewer.id,
    });
    expect(advertised.map((item) => item.name)).not.toContain(tool.name);

    const advertisedWithLocalBypass = await getAgentTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: viewer.id,
      skipAccessCheck: true,
    });
    expect(advertisedWithLocalBypass.map((item) => item.name)).not.toContain(
      tool.name,
    );

    const denied = await handleDelegation(
      tool.name,
      { message: "private" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: viewer.id,
      },
    );
    expect(denied.isError).toBe(true);
    expect((await journal()).requests).toEqual([]);

    const headless = await handleDelegation(
      tool.name,
      { message: "headless" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
      },
    );
    expect(headless.isError).not.toBe(true);
    expect((await journal()).requests).toHaveLength(1);
  });
});

function makeAgentCard(baseUrl: string) {
  return {
    name: "Fixture Agent",
    description: "External target used to verify outbound delegation.",
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
