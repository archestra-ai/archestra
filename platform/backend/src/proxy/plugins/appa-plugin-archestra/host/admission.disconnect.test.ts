import type { FastifyRequest } from "fastify";
import config from "@/config";
import { issueDisconnectReference } from "@/services/connection-disconnect-reference";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { resolveDisconnectBypass } from "./admission";

setupTestCacheManager();

const OWNER = "55555555-5555-4555-8555-555555555555";
const COPY = "66666666-6666-4666-8666-666666666666";

/** A Claude Code request of one conversation, whose first prompt is `prompt`. */
function request(conversation: string, prompt: string) {
  return {
    request: {
      headers: { "user-agent": "claude-cli/2.1.278 (external, cli)" },
    } as unknown as FastifyRequest,
    body: {
      metadata: { user_id: JSON.stringify({ session_id: conversation }) },
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }] },
        { role: "assistant", content: "I will read the page." },
      ],
    },
  };
}

test("the first conversation of the person that presents their reference runs ungoverned", async ({
  makeAgent,
  makeUser,
}) => {
  const agent = await makeAgent();
  const user = await makeUser();
  const { reference } = issueDisconnectReference({
    organizationId: agent.organizationId,
    userId: user.id,
    secret: config.auth.secret,
  });
  const prompt = `Read https://example.com/disconnect.md?client=claude-code&ref=${reference} and disconnect Claude Code.`;
  const bypass = (
    conversation: string,
    overrides: Partial<Parameters<typeof resolveDisconnectBypass>[0]> = {},
    text = prompt,
  ) =>
    resolveDisconnectBypass({
      ...request(conversation, text),
      agent,
      authenticatedUserId: user.id,
      appaActive: true,
      ...overrides,
    });

  // A request that proves no person, or that Guardrails do not govern.
  expect(await bypass(OWNER, { authenticatedUserId: undefined })).toBe(false);
  expect(await bypass(OWNER, { appaActive: false })).toBe(false);
  // Another person presenting it does not take the exemption from its owner.
  const other = await makeUser();
  expect(await bypass(COPY, { authenticatedUserId: other.id })).toBe(false);

  expect(await bypass(OWNER)).toBe(true);
  expect(await bypass(OWNER)).toBe(true);
  // A second conversation that got a copy of the prompt is checked.
  expect(await bypass(COPY)).toBe(false);
  expect(await bypass(OWNER, {}, "Disconnect Claude Code.")).toBe(false);
});

test("a routed Cursor chat keeps the exemption after its first tool call gives its session a name of its own", async ({
  makeAgent,
  makeUser,
}) => {
  const agent = await makeAgent();
  const user = await makeUser();
  const { reference } = issueDisconnectReference({
    organizationId: agent.organizationId,
    userId: user.id,
    secret: config.auth.secret,
  });
  const opening = {
    role: "user",
    content: `Read https://example.com/disconnect.md?client=cursor&ref=${reference} and disconnect Cursor.`,
  };
  const bypass = (messages: unknown[]) =>
    resolveDisconnectBypass({
      request: {
        headers: { "user-agent": "Cursor/3.30.14" },
      } as unknown as FastifyRequest,
      body: { model: "gpt-6", messages },
      agent,
      authenticatedUserId: user.id,
      appaActive: true,
    });

  expect(await bypass([opening])).toBe(true);
  // The cleanup's first call is in the history from here on.
  expect(
    await bypass([
      opening,
      {
        role: "assistant",
        content: [],
        tool_calls: [
          { id: "call_cleanup", function: { name: "Shell", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_cleanup", content: "removed" },
    ]),
  ).toBe(true);
  // Another chat that got a copy of the prompt is still checked.
  expect(
    await bypass([{ ...opening, content: `${opening.content} Please.` }]),
  ).toBe(false);
});
