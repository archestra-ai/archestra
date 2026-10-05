import { getArchestraToolFullName } from "@archestra/shared";
import { expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

test("credential tools create, list, update, and delete definitions without exposing values", async ({
  makeAgent,
  makeMember,
  makeOrganization,
  makeUser,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
  });
  await seedAndAssignArchestraTools(agent.id);
  const context: ArchestraContext = {
    agent: { id: agent.id, name: agent.name },
    agentId: agent.id,
    organizationId: organization.id,
    userId: user.id,
  };
  const invoke = (
    name: Parameters<typeof getArchestraToolFullName>[0],
    args: Record<string, unknown>,
  ) => executeArchestraTool(getArchestraToolFullName(name), args, context);

  const setup = await invoke("request_runtime_credential_setup", {
    kind: "github_app",
  });
  expect(setup.structuredContent).toMatchObject({
    action: "open_credential_dialog",
    kind: "github_app",
  });

  const created = await invoke("create_runtime_credential", {
    key: "sync-check",
    name: "Sync check",
    description: "Example credential",
    kind: "secret",
    allowPersonal: false,
    allowOrganization: true,
  });
  expect(created.isError).toBeFalsy();
  expect(created.structuredContent).toMatchObject({ key: "sync-check" });

  const listed = await invoke("list_runtime_credentials", {});
  expect(listed.structuredContent).toMatchObject({
    credentials: [
      expect.objectContaining({
        key: "sync-check",
        organizationConfigured: false,
      }),
    ],
  });
  expect(JSON.stringify(listed)).not.toContain("secret value");

  const updated = await invoke("update_runtime_credential", {
    key: "sync-check",
    changes: { name: "Renamed credential" },
  });
  expect(updated.isError).toBeFalsy();
  const detail = await invoke("get_runtime_credential", { key: "sync-check" });
  expect(detail.structuredContent).toMatchObject({
    name: "Renamed credential",
  });

  const deleted = await invoke("delete_runtime_credential", {
    key: "sync-check",
  });
  expect(deleted.structuredContent).toMatchObject({ deleted: "sync-check" });
  const after = await invoke("get_runtime_credential", { key: "sync-check" });
  expect(after.isError).toBe(true);
});
