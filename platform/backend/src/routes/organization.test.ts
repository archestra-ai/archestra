import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import ToolModel from "@/models/tool";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const VALID_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseFeatures: {
        ...actual.default.enterpriseFeatures,
        fullWhiteLabeling: true,
      },
    },
  };
});

describe("organization routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("syncs built-in MCP branding when appName changes under full white labeling", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        appName: "Acme Copilot",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).toHaveBeenCalledWith({
      organization: expect.objectContaining({
        appName: "Acme Copilot",
      }),
    });
  });

  test("does not resync built-in MCP branding when appName is unchanged", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test("does not resync built-in MCP branding when only logo assets change", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        logo: VALID_PNG_BASE64,
        logoDark: VALID_PNG_BASE64,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test("resyncs built-in MCP branding when iconLogo changes", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        iconLogo: VALID_PNG_BASE64,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).toHaveBeenCalledWith({
      organization: expect.objectContaining({
        iconLogo: VALID_PNG_BASE64,
      }),
    });
  });
});
