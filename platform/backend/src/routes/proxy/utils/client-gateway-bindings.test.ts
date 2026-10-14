import config from "@/config";
import ConnectionSetupModel from "@/models/connection-setup";
import MemberModel from "@/models/member";
import { issueConnectionInstructionsToken } from "@/services/connection-instructions-token";
import { issueConnectionRuntimeToken } from "@/services/connection-runtime-token";
import { expect, test } from "@/test";
import { resolveClientGatewayBindings } from "./client-gateway-bindings";
import { consumeClientRuntimeEvidence } from "./client-runtime-evidence";

function takeClientRuntimeEvidence(headers: Record<string, unknown>) {
  return consumeClientRuntimeEvidence({
    headers,
    raw: {
      headers,
      rawHeaders: Object.entries(headers).flatMap(([key, value]) => [
        key,
        String(value),
      ]),
    },
  });
}

test.each([
  '["primary","legacy","primary"]',
  "not-json",
  "[]",
  "[42]",
  '["bad\\nname"]',
  JSON.stringify(Array.from({ length: 65 }, (_, index) => `alias${index}`)),
])("private evidence is consumed before forwarding, including malformed values: %s", (aliases) => {
  const headers: Record<string, unknown> = {
    "X-Archestra-Client-Runtime-Token": "example-private-runtime-capability",
    "x-archestra-mcp-aliases": aliases,
    authorization: "Bearer example-inference-credential",
    "content-type": "application/json",
  };
  const evidence = takeClientRuntimeEvidence(headers);
  expect(headers).toEqual({
    authorization: "Bearer example-inference-credential",
    "content-type": "application/json",
  });
  if (aliases.startsWith('["primary"'))
    expect(evidence?.serverNames).toEqual(["primary", "legacy"]);
  else expect(evidence).toBeUndefined();
});

test("only a live installed connection in the request organization can endorse gateway aliases", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeAgent,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  await makeMember(user.id, organization.id);
  const gateway = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    access: "personal",
    agentType: "mcp_gateway",
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: organization.id,
    userId: user.id,
    clientId: "kilo",
    mcpGatewayId: gateway.id,
    baseUrl: "https://deployment.example.com/v1",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const token = issueConnectionRuntimeToken({
    setupId: setup.id,
    secret: config.auth.secret ?? "",
  });
  const evidence = () =>
    takeClientRuntimeEvidence({
      "x-archestra-client-runtime-token": token,
      "x-archestra-mcp-aliases": '["primary","legacy"]',
    });
  expect(
    await resolveClientGatewayBindings({
      evidence: evidence(),
      organizationId: organization.id,
    }),
  ).toBeUndefined();
  await ConnectionSetupModel.claimByToken({ rawToken });
  expect(
    await resolveClientGatewayBindings({
      evidence: evidence(),
      organizationId: organization.id,
    }),
  ).toEqual({ gatewayId: gateway.id, serverNames: ["primary", "legacy"] });
  expect(
    await resolveClientGatewayBindings({
      evidence: evidence(),
      organizationId: (await makeOrganization()).id,
    }),
  ).toBeUndefined();
  const instructionsToken = issueConnectionInstructionsToken({
    setupId: setup.id,
    secret: config.auth.secret ?? "",
  });
  const instructionsEvidence = takeClientRuntimeEvidence({
    "x-archestra-client-runtime-token": instructionsToken,
    "x-archestra-mcp-aliases": '["primary","legacy"]',
  });
  expect(
    await resolveClientGatewayBindings({
      evidence: instructionsEvidence,
      organizationId: organization.id,
    }),
  ).toBeUndefined();
  await MemberModel.deleteAllByUserId(user.id);
  expect(
    await resolveClientGatewayBindings({
      evidence: evidence(),
      organizationId: organization.id,
    }),
  ).toBeUndefined();
});

test("a proxy-enrolled capability endorses aliases only on its approved proxy", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeAgent,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  await makeMember(user.id, organization.id, { role: "admin" });
  const gateway = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "mcp_gateway",
  });
  const proxy = await makeAgent({
    organizationId: organization.id,
    agentType: "llm_proxy",
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: organization.id,
    userId: user.id,
    clientId: "kilo",
    mcpGatewayId: gateway.id,
    llmProxyId: proxy.id,
    baseUrl: "https://deployment.example.com/v1",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const token = issueConnectionRuntimeToken({
    setupId: setup.id,
    secret: config.auth.secret ?? "",
  });
  const evidence = () =>
    takeClientRuntimeEvidence({
      "x-archestra-client-runtime-token": token,
      "x-archestra-mcp-aliases": '["primary","legacy"]',
    });
  expect(
    await resolveClientGatewayBindings({
      evidence: evidence(),
      organizationId: organization.id,
      llmProxyId: proxy.id,
    }),
  ).toEqual({ gatewayId: gateway.id, serverNames: ["primary", "legacy"] });
  expect(
    await resolveClientGatewayBindings({
      evidence: evidence(),
      organizationId: organization.id,
      llmProxyId: gateway.id,
    }),
  ).toBeUndefined();
});
