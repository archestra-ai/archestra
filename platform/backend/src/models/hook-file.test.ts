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
  expect(await HookFileModel.listEnabledByAgent(agent.id, org.id)).toHaveLength(
    1,
  );

  const updated = await HookFileModel.update({
    id: created.id,
    organizationId: org.id,
    data: { enabled: false, requirements: ["httpx"] },
  });
  expect(updated?.enabled).toBe(false);
  expect(updated?.requirements).toEqual(["httpx"]);
  expect(await HookFileModel.listEnabledByAgent(agent.id, org.id)).toHaveLength(
    0,
  );

  expect(await HookFileModel.delete(created.id, org.id)).toBe(true);
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

  // findById / listByAgent / listEnabledByAgent must not leak across orgs.
  expect(await HookFileModel.findById(hook.id, org.id)).not.toBeNull();
  expect(await HookFileModel.findById(hook.id, otherOrg.id)).toBeNull();
  expect(await HookFileModel.listByAgent(agent.id, otherOrg.id)).toHaveLength(
    0,
  );
  expect(
    await HookFileModel.listEnabledByAgent(agent.id, otherOrg.id),
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
