import { type Mock, vi } from "vitest";
import { McpPresetEntryModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

describe("Preset entry validation regex", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: presetEntryRoutes } = await import("./mcp-preset-entry");
    await app.register(presetEntryRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("creates an entry with no validationRegex by default", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/organization/mcp-preset-entries",
      payload: { name: "production" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("production");
    expect(body.validationRegex).toBeNull();
  });

  test("creates an entry with an initial validationRegex", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/organization/mcp-preset-entries",
      payload: { name: "staging", validationRegex: "^https://prod\\." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().validationRegex).toBe("^https://prod\\.");
  });

  test("rejects an invalid regex on create", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/organization/mcp-preset-entries",
      payload: { name: "bad", validationRegex: "(" },
    });
    expect(res.statusCode).toBe(400);
  });

  test("PATCH updates an entry's validationRegex", async () => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "prod",
    });
    expect(entry.validationRegex).toBeNull();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/organization/mcp-preset-entries/${entry.id}`,
      payload: { validationRegex: "^[a-z]+$" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().validationRegex).toBe("^[a-z]+$");
  });

  test("PATCH clears the regex when sent null", async () => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "qa",
      validationRegex: "^x$",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/organization/mcp-preset-entries/${entry.id}`,
      payload: { validationRegex: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().validationRegex).toBeNull();
  });

  test("PATCH rejects an invalid regex", async () => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "dev",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/organization/mcp-preset-entries/${entry.id}`,
      payload: { validationRegex: "[" },
    });
    expect(res.statusCode).toBe(400);
  });

  test("PATCH 404s on an entry from a different organization", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const entry = await McpPresetEntryModel.create({
      organizationId: otherOrg.id,
      name: "other",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/organization/mcp-preset-entries/${entry.id}`,
      payload: { validationRegex: "^x$" },
    });
    expect(res.statusCode).toBe(404);
  });
});
