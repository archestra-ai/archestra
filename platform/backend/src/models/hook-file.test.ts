import { expect, test } from "@/test";
import HookFileModel from "./hook-file";

test("create/list/update/delete round-trip with requirements", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id, authorId: user.id });

  const created = await HookFileModel.create({
    organizationId: org.id,
    agentId: agent.id,
    event: "pre_tool_use",
    fileName: "guard.py",
    content: "import sys; sys.exit(0)",
    requirements: ["requests"],
  });
  expect(created.requirements).toEqual(["requests"]);

  expect(await HookFileModel.listByAgent(agent.id, org.id)).toHaveLength(1);
  expect(
    await HookFileModel.listEnabledByAgentAndEvent({
      agentId: agent.id,
      organizationId: org.id,
      event: "pre_tool_use",
    }),
  ).toHaveLength(1);

  const updated = await HookFileModel.update({
    id: created.id,
    organizationId: org.id,
    data: { enabled: false, requirements: ["httpx"] },
  });
  expect(updated?.enabled).toBe(false);
  expect(updated?.requirements).toEqual(["httpx"]);
  expect(
    await HookFileModel.listEnabledByAgentAndEvent({
      agentId: agent.id,
      organizationId: org.id,
      event: "pre_tool_use",
    }),
  ).toHaveLength(0);

  expect(await HookFileModel.delete(created.id, org.id)).toBe(true);
});

test("listEnabledByAgentAndEvent returns only enabled hooks for that event, in fileName order", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id, authorId: user.id });

  const base = {
    organizationId: org.id,
    agentId: agent.id,
    content: "exit 0",
    requirements: [],
  };
  await HookFileModel.create({
    ...base,
    event: "pre_tool_use",
    fileName: "b-guard.py",
  });
  await HookFileModel.create({
    ...base,
    event: "pre_tool_use",
    fileName: "a-guard.py",
  });
  await HookFileModel.create({
    ...base,
    event: "post_tool_use",
    fileName: "audit.sh",
  });
  const disabled = await HookFileModel.create({
    ...base,
    event: "pre_tool_use",
    fileName: "disabled.py",
  });
  await HookFileModel.update({
    id: disabled.id,
    organizationId: org.id,
    data: { enabled: false },
  });

  const preHooks = await HookFileModel.listEnabledByAgentAndEvent({
    agentId: agent.id,
    organizationId: org.id,
    event: "pre_tool_use",
  });
  expect(preHooks.map((h) => h.fileName)).toEqual(["a-guard.py", "b-guard.py"]);

  expect(
    await HookFileModel.listEnabledByAgentAndEvent({
      agentId: agent.id,
      organizationId: org.id,
      event: "session_start",
    }),
  ).toHaveLength(0);
});

test("every method is org-scoped — a foreign org cannot read or mutate", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id, authorId: user.id });

  const hook = await HookFileModel.create({
    organizationId: org.id,
    agentId: agent.id,
    event: "post_tool_use",
    fileName: "audit.sh",
    content: "exit 0",
    requirements: [],
  });

  // findById / listByAgent / listEnabledByAgentAndEvent must not leak across orgs.
  expect(await HookFileModel.findById(hook.id, org.id)).not.toBeNull();
  expect(await HookFileModel.findById(hook.id, otherOrg.id)).toBeNull();
  expect(await HookFileModel.listByAgent(agent.id, otherOrg.id)).toHaveLength(
    0,
  );
  expect(
    await HookFileModel.listEnabledByAgentAndEvent({
      agentId: agent.id,
      organizationId: otherOrg.id,
      event: "post_tool_use",
    }),
  ).toHaveLength(0);

  // update / delete scoped to the wrong org are no-ops.
  expect(
    await HookFileModel.update({
      id: hook.id,
      organizationId: otherOrg.id,
      data: { enabled: false },
    }),
  ).toBeNull();
  expect(await HookFileModel.delete(hook.id, otherOrg.id)).toBe(false);
  expect(await HookFileModel.findById(hook.id, org.id)).not.toBeNull();
});
