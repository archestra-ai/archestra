import {
  ARCHESTRA_MCP_CATALOG_ID,
  getArchestraToolFullName,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { afterEach } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { getArchestraMcpCatalogMetadata } from "@/archestra-mcp-server/metadata";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import OrganizationModel from "./organization";
import ToolModel from "./tool";

// This test provokes a uniqueness violation that production code catches and
// recovers from. It must run without the outer rollback transaction: PostgreSQL
// marks that transaction aborted when the collision occurs.
test("does not crash startup when a legacy/branded prefix duplicate exists", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  await OrganizationModel.patch(org.id, { appName: "Acme Copilot" });
  const brandedOrg = { appName: "Acme Copilot", iconLogo: null };

  archestraMcpBranding.syncFromOrganization(brandedOrg);
  const brandedName = archestraMcpBranding.getToolName(
    TOOL_TODO_WRITE_SHORT_NAME,
  );
  const legacyName = getArchestraToolFullName(TOOL_TODO_WRITE_SHORT_NAME, {
    appName: null,
    fullWhiteLabeling: false,
  });

  await db.insert(schema.internalMcpCatalogTable).values({
    id: ARCHESTRA_MCP_CATALOG_ID,
    ...getArchestraMcpCatalogMetadata(),
  });
  // Stage a legacy + branded sibling for one built-in (same short name,
  // different prefix). Branded row first so reconciliation keeps the legacy
  // row and attempts the colliding rename onto the existing branded name.
  await db.insert(schema.toolsTable).values({
    name: brandedName,
    parameters: {},
    catalogId: ARCHESTRA_MCP_CATALOG_ID,
    agentId: null,
  });
  await db.insert(schema.toolsTable).values({
    name: legacyName,
    parameters: {},
    catalogId: ARCHESTRA_MCP_CATALOG_ID,
    agentId: null,
  });

  // Reseeding under branding renames the legacy row toward the branded name,
  // which collides with the staged sibling. One built-in conflict must not
  // crash startup — seeding resolves.
  await expect(
    ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID, brandedOrg),
  ).resolves.not.toThrow();

  // The branded built-in converges to exactly one row.
  const brandedRows = await db
    .select()
    .from(schema.toolsTable)
    .where(
      and(
        eq(schema.toolsTable.catalogId, ARCHESTRA_MCP_CATALOG_ID),
        eq(schema.toolsTable.name, brandedName),
      ),
    );
  expect(brandedRows).toHaveLength(1);
});

afterEach(() => {
  archestraMcpBranding.syncFromOrganization(null);
});
