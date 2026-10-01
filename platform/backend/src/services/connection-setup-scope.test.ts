import { beforeEach, expect, test, vi } from "vitest";
import { setupTestCacheManager } from "@/test/cache-manager";
import { beginConnectionPromptSession } from "./connection-prompt-session";
import { issueConnectionSetupContext } from "./connection-setup-context";
import {
  nativeSetupClientFromProvenance,
  resolveConnectionSetupScope,
} from "./connection-setup-scope";

// The real cache, stored in this file's test database.
setupTestCacheManager();

const userId = "user-1";
const organizationId = "org-1";
const origin = "https://ai.example.com";
const principal = {
  userId,
  organizationId,
  targetOrganizationId: organizationId,
  guardrailsActive: true,
};

beforeEach(() => vi.useRealTimers());

test.each([
  {
    clientId: "claude-code" as const,
    label: "Claude Code",
    provenance: "claude-code-header" as const,
    body: (prompt: string) => ({
      messages: [{ role: "user", content: prompt }],
    }),
  },
  {
    clientId: "claude-code" as const,
    label: "Claude Code",
    provenance: "claude-code-metadata" as const,
    body: (prompt: string) => ({
      messages: [{ role: "user", content: prompt }],
    }),
  },
  {
    clientId: "codex" as const,
    label: "Codex",
    provenance: "codex-turn-metadata" as const,
    body: (prompt: string) => ({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
    }),
  },
  {
    clientId: "opencode" as const,
    label: "OpenCode",
    provenance: "opencode-session-header" as const,
    body: (prompt: string) => ({
      messages: [{ role: "user", content: prompt }],
    }),
  },
  {
    clientId: "opencode" as const,
    label: "OpenCode",
    provenance: "opencode-hosted-header" as const,
    body: (prompt: string) => ({
      messages: [{ role: "user", content: prompt }],
    }),
  },
])("binds $clientId through the same native-session scope", async ({
  clientId,
  label,
  provenance,
  body,
}) => {
  await beginConnectionPromptSession({
    userId,
    organizationId,
    clientId,
    origin,
  });
  const prompt = `Read ${origin}/connect.md?client=${clientId} and connect ${label}.`;
  const evidence = {
    kind: "native-session" as const,
    identity: { provenance, sessionId: `native-${provenance}` },
    requestBody: body(prompt),
  };
  expect(await resolveConnectionSetupScope({ principal, evidence })).toEqual({
    kind: "native-session",
    userId,
    organizationId,
    clientId,
  });
  expect(
    await resolveConnectionSetupScope({
      principal,
      evidence: { ...evidence, requestBody: { messages: [] } },
    }),
  ).toEqual(expect.objectContaining({ kind: "native-session", clientId }));
});

test("missing or unrecognized native identity leaves the prompt window untouched", async () => {
  await beginConnectionPromptSession({
    userId,
    organizationId,
    clientId: "claude-code",
    origin,
  });
  const prompt = `Read ${origin}/connect.md?client=claude-code and connect Claude Code.`;
  for (const provenance of [
    "claude-metadata",
    "prompt-cache-key",
    "appa-header",
  ] as const) {
    expect(nativeSetupClientFromProvenance(provenance)).toBeUndefined();
    expect(
      await resolveConnectionSetupScope({
        principal,
        evidence: {
          kind: "native-session",
          identity: { provenance, sessionId: "native-1" },
          requestBody: { messages: [{ role: "user", content: prompt }] },
        },
      }),
    ).toBeNull();
  }
  expect(
    await resolveConnectionSetupScope({
      principal,
      evidence: {
        kind: "native-session",
        identity: { provenance: "claude-code-header", sessionId: "native-1" },
        requestBody: { messages: [{ role: "user", content: prompt }] },
      },
    }),
  ).not.toBeNull();
});

test("principal and deployment gates deny native scope without consuming it", async () => {
  await beginConnectionPromptSession({
    userId,
    organizationId,
    clientId: "opencode",
    origin,
  });
  const evidence = {
    kind: "native-session" as const,
    identity: {
      provenance: "opencode-session-header" as const,
      sessionId: "native-1",
    },
    requestBody: {
      messages: [
        {
          role: "user",
          content: `Read ${origin}/connect.md?client=opencode and connect OpenCode.`,
        },
      ],
    },
  };
  for (const altered of [
    { ...principal, userId: undefined },
    { ...principal, organizationId: "other-org" },
    { ...principal, targetOrganizationId: "other-org" },
    { ...principal, guardrailsActive: false },
  ]) {
    expect(
      await resolveConnectionSetupScope({ principal: altered, evidence }),
    ).toBeNull();
  }
  expect(
    await resolveConnectionSetupScope({ principal, evidence }),
  ).not.toBeNull();
});

test("approved installer scope is bound to authenticated user, org, and gateway", async () => {
  const secret = "a-shared-signing-key-for-setup";
  const gatewayId = "gateway-1";
  const evidence = {
    kind: "approved-installer" as const,
    token: issueConnectionSetupContext({
      userId,
      organizationId,
      gatewayId,
      setupId: "approved-setup-1",
      secret,
    }),
    gatewayId,
    signingSecret: secret,
  };
  expect(await resolveConnectionSetupScope({ principal, evidence })).toEqual({
    kind: "approved-installer",
    userId,
    organizationId,
    gatewayId,
  });
  expect(
    await resolveConnectionSetupScope({
      principal: { ...principal, userId: "other-user" },
      evidence,
    }),
  ).toBeNull();
  expect(
    await resolveConnectionSetupScope({
      principal,
      evidence: { ...evidence, gatewayId: "other-gateway" },
    }),
  ).toBeNull();
  expect(
    await resolveConnectionSetupScope({
      principal: { ...principal, guardrailsActive: false },
      evidence,
    }),
  ).toBeNull();
});
