import { vi } from "vitest";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ConversationModel from "@/models/conversation";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { afterEach, beforeEach, expect, test } from "@/test";
import type { User } from "@/types";

const statusRead = vi.hoisted(() => vi.fn());
vi.mock("@/openappa/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/openappa/service")>()),
  getOpenappaStatus: statusRead,
}));

let app: FastifyInstanceWithZod;
let user: User;
let organizationId: string;
let conversationId: string;
let agentId: string;

beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
  user = await makeUser();
  organizationId = (await makeOrganization()).id;
  await makeMember(user.id, organizationId, { role: "admin" });
  const agent = await makeAgent({
    organizationId,
    authorId: user.id,
    access: "personal",
  });
  agentId = agent.id;
  conversationId = (
    await ConversationModel.create({
      organizationId,
      userId: user.id,
      agentId: agent.id,
    })
  ).id;
  config.openappa.enabled = true;
  await GuardrailsDeploymentModel.setEnabled(true);
  statusRead.mockReset();

  app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: User }).user = user;
    (request as typeof request & { organizationId: string }).organizationId =
      organizationId;
  });
  const { default: chatRoutes } = await import("./routes");
  await app.register(chatRoutes);
});

afterEach(async () => {
  await app.close();
});

const statusUrl = () =>
  `/api/chat/conversations/${conversationId}/openappa-status`;

test("reads the current status of an accessible protected conversation", async () => {
  statusRead.mockResolvedValue({ trust: "suspicious", audience: "internal" });
  const response = await app.inject({ method: "GET", url: statusUrl() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    trust: "suspicious",
    audience: "internal",
  });
  expect(statusRead).toHaveBeenCalledWith({
    organizationId,
    sessionId: conversationId,
  });
});

test("returns null before a session has opened", async () => {
  statusRead.mockResolvedValue(null);
  const response = await app.inject({ method: "GET", url: statusUrl() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toBeNull();
});

test("reports a failed OpenAPPA status read", async () => {
  statusRead.mockRejectedValue(new Error("status read failed"));
  const response = await app.inject({ method: "GET", url: statusUrl() });
  expect(response.statusCode).toBe(500);
  expect(statusRead).toHaveBeenCalledOnce();
});

test.each([
  "environment flag",
  "deployment switch",
])("hides status when the %s is off", async (switchName) => {
  if (switchName === "environment flag") config.openappa.enabled = false;
  else await GuardrailsDeploymentModel.setEnabled(false);
  const response = await app.inject({ method: "GET", url: statusUrl() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toBeNull();
  expect(statusRead).not.toHaveBeenCalled();
});

test.each([
  false,
  true,
])("returns null for a locked chat whether a browser key is supplied: %s", async (withKey) => {
  conversationId = (
    await ConversationModel.create({
      organizationId,
      userId: user.id,
      agentId,
      lockedChat: true,
      lockedChatDekFingerprint: "fingerprint",
    })
  ).id;
  statusRead.mockResolvedValue({ trust: "suspicious", audience: "internal" });
  const response = await app.inject({
    method: "GET",
    url: statusUrl(),
    headers: withKey
      ? { "x-archestra-locked-chat-key": "YnJvd3Nlci1rZXk" }
      : undefined,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toBeNull();
  expect(statusRead).not.toHaveBeenCalled();
});

test("does not read status across organization boundaries", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
}) => {
  const otherUser = await makeUser();
  const otherOrgId = (await makeOrganization()).id;
  await makeMember(otherUser.id, otherOrgId, { role: "admin" });
  const otherAgent = await makeAgent({
    organizationId: otherOrgId,
    authorId: otherUser.id,
  });
  conversationId = (
    await ConversationModel.create({
      organizationId: otherOrgId,
      userId: otherUser.id,
      agentId: otherAgent.id,
    })
  ).id;
  const response = await app.inject({ method: "GET", url: statusUrl() });
  expect(response.statusCode).toBe(404);
  expect(statusRead).not.toHaveBeenCalled();
});

test("does not read another user's private conversation in the same organization", async ({
  makeUser,
  makeMember,
  makeAgent,
}) => {
  const otherUser = await makeUser();
  await makeMember(otherUser.id, organizationId, { role: "member" });
  const otherAgent = await makeAgent({
    organizationId,
    authorId: otherUser.id,
    access: "personal",
  });
  conversationId = (
    await ConversationModel.create({
      organizationId,
      userId: otherUser.id,
      agentId: otherAgent.id,
    })
  ).id;
  const response = await app.inject({ method: "GET", url: statusUrl() });
  expect(response.statusCode).toBe(404);
  expect(statusRead).not.toHaveBeenCalled();
});
