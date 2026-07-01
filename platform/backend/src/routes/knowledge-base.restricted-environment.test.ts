import { type Mock, vi } from "vitest";
import { KnowledgeBaseConnectorModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// The connector write paths gate environment assignment exactly like the agent
// and MCP-catalog paths: assigning a *restricted* environment requires
// environment:deploy-to-restricted (or environment:admin). The gate computes
// canDeployToRestricted from `userHasPermission`, so we override only that
// export (resource-aware) and leave the rest of @/auth/utils intact.
vi.mock("@/auth/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/utils")>();
  return { ...actual, userHasPermission: vi.fn() };
});

import { userHasPermission } from "@/auth/utils";
import { createEnvironment } from "@/services/environments/environment";

const mockUserHasPermission = userHasPermission as Mock;

describe("Knowledge connector - restricted environment assignment guard", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  // Toggles the answer to the environment permission probes (admin / deploy).
  let canDeployToRestricted: boolean;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    canDeployToRestricted = false;
    // Only the `environment` probe varies per test; everything else (knowledge
    // source access, etc.) is granted so the suite isolates the environment gate.
    mockUserHasPermission.mockImplementation(
      async (_userId: string, _organizationId: string, resource: string) =>
        resource === "environment" ? canDeployToRestricted : true,
    );

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./knowledge-base");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  function createBody(environmentId: string | null) {
    return {
      name: `conn-${crypto.randomUUID().slice(0, 8)}`,
      connectorType: "web_crawler" as const,
      config: { type: "web_crawler", startUrl: "https://example.com" },
      environmentId,
    };
  }

  async function makeConnector(environmentId: string | null) {
    return KnowledgeBaseConnectorModel.create({
      organizationId,
      name: `conn-${crypto.randomUUID().slice(0, 8)}`,
      connectorType: "web_crawler",
      config: { type: "web_crawler", startUrl: "https://example.com" },
      environmentId,
    });
  }

  test("creating a connector in a RESTRICTED env without deploy-to-restricted is 403", async () => {
    canDeployToRestricted = false;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: createBody(restricted.id),
    });

    expect(response.statusCode).toBe(403);
  });

  test("updating a connector to a RESTRICTED env without deploy-to-restricted is 403 and unchanged", async () => {
    canDeployToRestricted = false;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });
    const connector = await makeConnector(null);

    const response = await app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(response.statusCode).toBe(403);
    const after = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(after?.environmentId ?? null).toBeNull();
  });

  test("updating a connector to a RESTRICTED env WITH deploy-to-restricted persists (200)", async () => {
    canDeployToRestricted = true;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });
    const connector = await makeConnector(null);

    const response = await app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(restricted.id);
  });

  test("updating a connector to an UNRESTRICTED env without deploy-to-restricted succeeds (200)", async () => {
    canDeployToRestricted = false;
    const open = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });
    const connector = await makeConnector(null);

    const response = await app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { environmentId: open.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(open.id);
  });
});
