// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { eq, sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import {
  syncBuiltInAgents,
  syncOpenAppaConfigAgentCapabilities,
} from "@/services/seed";
import { SRE_AGENT_ID, SRE_CATALOG_ID } from "@/services/sre-agent/definition";
import { describe, expect, test } from "@/test";
import { enableSre, seedSreAgent } from "@/test/sre-agent";

const statements = fs
  .readFileSync(
    path.join(__dirname, "0621_retire-sre-role-permission.sql"),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

describe("retiring SRE RBAC and narrowing built-in defaults", () => {
  test("narrows untouched SRE and APPA Keeper policies while preserving edited grants", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    enableSre([]);
    config.openappa.enabled = false;
    const { organizationId } = await seedSreAgent({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const otherOrg = await makeOrganization();
    await syncBuiltInAgents();
    await syncOpenAppaConfigAgentCapabilities();
    const appa = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
      organizationId,
    );
    const editedAppa = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
      otherOrg.id,
    );
    if (!appa || !editedAppa) throw new Error("APPA Keeper missing");

    const broad = JSON.stringify([
      { subject: { type: "organization", id: "*" }, actions: ["read", "use"] },
    ]);
    const mainSreDefault = JSON.stringify([
      { subject: { type: "role", id: "admin" }, actions: ["read", "use"] },
      {
        subject: { type: "user", id: "original-admin" },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);
    for (const [resource, scope] of [
      ["agent", SRE_AGENT_ID],
      ["mcpRegistry", SRE_CATALOG_ID],
      ["agent", appa.id],
    ] as const) {
      await db.execute(sql`UPDATE resource_permission_policies
        SET grants = ${scope === appa.id ? broad : mainSreDefault}::jsonb, revision = 1,
          legacy_organization_audience = ${scope === appa.id}
        WHERE organization_id = ${organizationId}
          AND resource = ${resource} AND scope = ${scope}`);
    }
    const editedGrants = [
      {
        subject: { type: "organization" as const, id: "*" as const },
        actions: ["read" as const, "use" as const],
      },
    ];
    await db
      .update(schema.resourcePermissionPoliciesTable)
      .set({
        grants: editedGrants,
        revision: 2,
        legacyOrganizationAudience: true,
      })
      .where(eq(schema.resourcePermissionPoliciesTable.scope, editedAppa.id));

    for (const statement of statements) await db.execute(sql.raw(statement));

    for (const [resource, scope] of [
      ["agent", SRE_AGENT_ID],
      ["mcpRegistry", SRE_CATALOG_ID],
      ["agent", appa.id],
    ] as const) {
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId,
        resource,
        scope,
      });
      expect(policy?.grants).toEqual([
        {
          subject: { type: "role", id: "admin" },
          actions: ["read", "use", "update", "delete", "manage-permissions"],
        },
        {
          subject: { type: "role", id: "platform_admin" },
          actions: ["read", "use", "update", "delete", "manage-permissions"],
        },
      ]);
      expect(policy?.legacyOrganizationAudience).toBe(false);
    }
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: otherOrg.id,
          resource: "agent",
          scope: editedAppa.id,
        })
      )?.grants,
    ).toEqual(editedGrants);
  });
});
