// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL(
  "../src/database/migrations/0620_retire-sre-role-permission.sql",
  import.meta.url,
);
const catalogId = "00000000-0000-4000-8000-000000000510";
const agentId = "00000000-0000-4000-8000-000000000512";

test("retiring sre:read preserves custom-role catalog access and upgrades the agent", async (t) => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE organization_role (
      id text PRIMARY KEY, organization_id text NOT NULL,
      permission text NOT NULL, updated_at timestamp
    );
    CREATE TABLE resource_permission_policies (
      organization_id text NOT NULL, resource text NOT NULL, scope text NOT NULL,
      grants jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
      legacy_organization_audience boolean NOT NULL DEFAULT false,
      updated_at timestamp DEFAULT now(),
      PRIMARY KEY (organization_id, resource, scope)
    );
    CREATE TABLE agents (
      id uuid PRIMARY KEY, organization_id text NOT NULL,
      built_in_agent_config jsonb, deleted_at timestamp
    );
    CREATE TABLE internal_mcp_catalog (
      id uuid PRIMARY KEY, organization_id text NOT NULL
    );
    INSERT INTO organization_role (id, organization_id, permission) VALUES
      ('sre-reader', 'org-one', '{"agent":["read"],"sre":["read"]}'),
      ('sre-new', 'org-one', '{"sre":["read"]}'),
      ('other-role', 'org-one', '{"agent":["read"]}'),
      ('future-reader', 'org-two', '{"sre":["read"]}');
    INSERT INTO resource_permission_policies (organization_id, resource, scope, grants)
      VALUES ('org-one', 'agent', '${agentId}',
        '[{"subject":{"type":"role","id":"sre-reader"},"actions":["manage-permissions"]}]');
    INSERT INTO agents (id, organization_id) VALUES ('${agentId}', 'org-one');
    INSERT INTO internal_mcp_catalog (id, organization_id) VALUES ('${catalogId}', 'org-one');
  `);

  const sql = await readFile(migration, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    await pg.exec(statement);
  }
  // Replaying the SQL has no legacy role entries left to transfer.
  for (const statement of sql.split("--> statement-breakpoint")) {
    await pg.exec(statement);
  }

  const roles = (await pg.query("SELECT id, permission::jsonb AS permission FROM organization_role ORDER BY id")).rows;
  assert.deepEqual(roles, [
    { id: "future-reader", permission: {} },
    { id: "other-role", permission: { agent: ["read"] } },
    { id: "sre-new", permission: {} },
    { id: "sre-reader", permission: { agent: ["read"] } },
  ]);
  const policies = (await pg.query("SELECT organization_id, resource, grants FROM resource_permission_policies ORDER BY organization_id, resource")).rows;
  assert.deepEqual(policies.map(({ organization_id, resource, grants }) => ({
    organization_id, resource,
    roles: grants.map((grant) => ({ id: grant.subject.id, actions: grant.actions })).sort((a, b) => a.id.localeCompare(b.id)),
  })), [
    { organization_id: "org-one", resource: "agent", roles: [
      { id: "sre-new", actions: ["read", "use"] },
      { id: "sre-reader", actions: ["manage-permissions", "read", "use"] },
    ] },
    { organization_id: "org-one", resource: "mcpRegistry", roles: [
      { id: "admin", actions: ["read", "use", "update", "delete", "manage-permissions"] },
      { id: "platform_admin", actions: ["read", "use", "update", "delete", "manage-permissions"] },
      { id: "sre-new", actions: ["read", "use"] },
      { id: "sre-reader", actions: ["read", "use"] },
    ] },
  ]);
  const [agent] = (await pg.query("SELECT built_in_agent_config FROM agents WHERE id = $1", [agentId])).rows;
  assert.deepEqual(agent.built_in_agent_config, { name: "sre-agent" });
});
