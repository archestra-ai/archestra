import {
  BatteryCredentialRequestSchema,
  getArchestraToolFullName,
} from "@archestra/shared";
import { openappaDeclarations } from "@/openappa/declarations";
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

test("request_battery_credentials resolves each battery's setup for the card", async ({
  makeMember,
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });
  const context: ArchestraContext = {
    agent: { id: "agent", name: "Agent" },
    organizationId: organization.id,
    userId: user.id,
  };
  const bundled = new Map(
    (await openappaDeclarations.bundledBatteries()).map((battery) => [
      battery.name,
      battery,
    ]),
  );

  const result = await executeArchestraTool(
    getArchestraToolFullName("request_battery_credentials"),
    { batteries: ["slack", "github", "slack"] },
    context,
  );

  expect(result.isError).toBeFalsy();
  const { batteries } = BatteryCredentialRequestSchema.parse(
    result.structuredContent,
  );
  expect(batteries.map(({ name, title }) => [name, title])).toEqual([
    ["slack", "Slack"],
    ["github", "GitHub"],
  ]);
  for (const battery of batteries) {
    const native = bundled.get(battery.name);
    expect(battery.benefit).toBe(native?.benefit);
    expect(battery.credentials).toEqual(native?.credentials);
    expect(battery.setup.length).toBeGreaterThan(1);
    expect(battery.setup.join("\n")).toBe(native?.setup);
  }
});

test("request_battery_credentials names a battery it does not know", async ({
  makeMember,
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });

  const result = await executeArchestraTool(
    getArchestraToolFullName("request_battery_credentials"),
    { batteries: ["slack", "no-such-battery"] },
    {
      agent: { id: "agent", name: "Agent" },
      organizationId: organization.id,
      userId: user.id,
    },
  );

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("no-such-battery");
  expect(result.structuredContent).toBeUndefined();
});

test("request_battery_credentials needs permission to create credentials", async ({
  makeMember,
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "member" });

  const result = await executeArchestraTool(
    getArchestraToolFullName("request_battery_credentials"),
    { batteries: ["slack"] },
    {
      agent: { id: "agent", name: "Agent" },
      organizationId: organization.id,
      userId: user.id,
    },
  );

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("credential:create");
  expect(result.structuredContent).toBeUndefined();
});
