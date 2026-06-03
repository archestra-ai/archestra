import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: {
    isEnabled: false,
    validateNamespace: vi.fn(),
    getOrLoadDeployment: vi.fn(),
    restartServer: vi.fn(),
    reinstallSharedDeployment: vi.fn(),
  },
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

describe("Environment kubernetes namespace", () => {
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

    const { default: environmentRoutes } = await import("./environment");
    await app.register(environmentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("creates an environment and namespace is null by default", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "sandbox" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().namespace).toBeNull();
  });

  test("PATCH sets namespace", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "production" },
    });
    const { id } = create.json();

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/environments/${id}`,
      payload: { namespace: "prod-ns" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().namespace).toBe("prod-ns");
  });

  test("PATCH clears namespace with null", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "dev", namespace: "dev-ns" },
    });
    const { id } = create.json();

    const clear = await app.inject({
      method: "PATCH",
      url: `/api/environments/${id}`,
      payload: { namespace: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().namespace).toBeNull();
  });

  test("PATCH rejects invalid namespace names", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "test" },
    });
    const { id } = create.json();

    for (const invalid of [
      "UPPERCASE",
      "-leading-hyphen",
      "trailing-hyphen-",
      "has spaces",
      "a".repeat(64),
    ]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/environments/${id}`,
        payload: { namespace: invalid },
      });
      expect(res.statusCode, `Expected 400 for "${invalid}"`).toBe(400);
    }
  });

  test("GET list includes namespace field", async () => {
    await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "list-test", namespace: "list-ns" },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/environments",
    });
    expect(list.statusCode).toBe(200);
    const { environments: entries } = list.json();
    expect(entries.length).toBeGreaterThan(0);
    expect("namespace" in entries[0]).toBe(true);
    expect(entries[0].namespace).toBe("list-ns");
  });
});
