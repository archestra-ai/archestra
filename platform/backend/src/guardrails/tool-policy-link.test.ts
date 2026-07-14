import config from "@/config";
import { expect, test } from "@/test";
import type { PolicyBlockResult } from "./tool-invocation";
import { buildPolicyBlockedToolResult } from "./tool-policy-link";

const TOOL_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_NAME = "server__do_thing";

function makePolicyBlock(
  overrides: Partial<PolicyBlockResult> = {},
): PolicyBlockResult {
  return {
    refusalMessage: "REFUSAL PROSE",
    contentMessage: "CONTENT PROSE",
    reason: "not allowed",
    blockedToolName: TOOL_NAME,
    blockedToolId: TOOL_ID,
    toolInput: { foo: "bar" },
    allToolCallNames: [TOOL_NAME],
    ...overrides,
  };
}

test("includes a permission-gated deep link for a caller who can edit guardrails", async ({
  makeUser,
  makeOrganization,
  makeMember,
}) => {
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });

  const { error, text } = await buildPolicyBlockedToolResult({
    policyBlock: makePolicyBlock(),
    userId: admin.id,
    organizationId: org.id,
  });

  expect(error.policyUrl).toBeDefined();
  const url = new URL(error.policyUrl as string);
  expect(url.origin).toBe(new URL(config.frontendBaseUrl).origin);
  expect(url.pathname).toBe("/mcp/tool-guardrails");
  expect(url.searchParams.get("toolId")).toBe(TOOL_ID);
  expect(url.searchParams.get("toolName")).toBe(TOOL_NAME);

  // The prose the external client renders carries the link too.
  expect(text).toContain("REFUSAL PROSE");
  expect(text).toContain(error.policyUrl as string);
});

test("omits the deep link for a caller who cannot edit guardrails", async ({
  makeUser,
  makeOrganization,
  makeMember,
}) => {
  const org = await makeOrganization();
  const member = await makeUser();
  await makeMember(member.id, org.id, { role: "member" });

  const { error, text } = await buildPolicyBlockedToolResult({
    policyBlock: makePolicyBlock(),
    userId: member.id,
    organizationId: org.id,
  });

  expect(error.policyUrl).toBeUndefined();
  expect(text).toBe("REFUSAL PROSE");
  expect(text).not.toContain("/mcp/tool-guardrails");
});

test("omits the deep link when there is no acting user (e.g. org token)", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();

  const { error } = await buildPolicyBlockedToolResult({
    policyBlock: makePolicyBlock(),
    userId: undefined,
    organizationId: org.id,
  });

  expect(error.policyUrl).toBeUndefined();
});

test("omits the deep link when the blocked tool row is unknown", async ({
  makeUser,
  makeOrganization,
  makeMember,
}) => {
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });

  const { error } = await buildPolicyBlockedToolResult({
    policyBlock: makePolicyBlock({ blockedToolId: undefined }),
    userId: admin.id,
    organizationId: org.id,
  });

  expect(error.policyUrl).toBeUndefined();
});

test("applies the text prefix for the run_tool surface", async ({
  makeUser,
  makeOrganization,
  makeMember,
}) => {
  const org = await makeOrganization();
  const member = await makeUser();
  await makeMember(member.id, org.id, { role: "member" });

  const { text } = await buildPolicyBlockedToolResult({
    policyBlock: makePolicyBlock(),
    userId: member.id,
    organizationId: org.id,
    textPrefix: "Error: ",
  });

  expect(text).toBe("Error: REFUSAL PROSE");
});
