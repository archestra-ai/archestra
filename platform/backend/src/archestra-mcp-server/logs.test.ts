import { getArchestraToolFullName } from "@archestra/shared";
import { expect, test } from "@/test";
import { executeArchestraTool } from ".";
import type { ArchestraContext } from "./types";

test("gateway log tools paginate sessions and enforce own-log visibility", async ({
  makeAgent,
  makeCustomRole,
  makeInteraction,
  makeMember,
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const reader = await makeUser();
  const other = await makeUser();
  const role = await makeCustomRole(organization.id, {
    permission: { log: ["read"] },
  });
  await makeMember(reader.id, organization.id, { role: role.role });
  const agent = await makeAgent({ organizationId: organization.id });
  const own = await makeInteraction(agent.id, {
    userId: reader.id,
    sessionId: "shared-session",
  });
  const foreign = await makeInteraction(agent.id, {
    userId: other.id,
    sessionId: "shared-session",
  });
  const context: ArchestraContext = {
    agent: { id: agent.id, name: agent.name },
    organizationId: organization.id,
    userId: reader.id,
  };
  const call = (
    name:
      | "list_llm_interactions"
      | "get_llm_interaction"
      | "list_llm_sessions"
      | "get_llm_session_logs",
    args: object,
  ) =>
    executeArchestraTool(getArchestraToolFullName(name), args, context);

  const interactions = await call("list_llm_interactions", {
    user_id: other.id,
    limit: 1,
  });
  expect(interactions.isError).toBe(false);
  expect(
    (interactions.structuredContent as { data: { id: string }[] }).data.map(
      (row) => row.id,
    ),
  ).toEqual([own.id]);
  expect(
    (interactions.structuredContent as { data: { request?: unknown }[] })
      .data[0],
  ).not.toHaveProperty("request");

  const sessions = await call("list_llm_sessions", { limit: 1 });
  expect(sessions.isError).toBe(false);
  expect(
    (
      sessions.structuredContent as {
        data: { sessionId: string; requestCount: number }[];
      }
    ).data,
  ).toMatchObject([{ sessionId: "shared-session", requestCount: 1 }]);

  const logs = await call("get_llm_session_logs", {
    session_id: "shared-session",
    limit: 1,
  });
  expect(logs.isError).toBe(false);
  expect(
    (logs.structuredContent as { data: { id: string; request: unknown }[] })
      .data,
  ).toMatchObject([{ id: own.id, request: expect.any(Object) }]);
  expect(
    (logs.structuredContent as { pagination: { total: number } }).pagination
      .total,
  ).toBe(1);

  const hidden = await call("get_llm_interaction", {
    interaction_id: foreign.id,
  });
  expect(hidden.isError).toBe(true);
  const detail = await call("get_llm_interaction", { interaction_id: own.id });
  expect(detail.structuredContent).toMatchObject({
    interaction: { id: own.id },
  });
});
