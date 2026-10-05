import { vi } from "vitest";

import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import { cacheManager } from "@/cache-manager";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import { recognizeConnectionSetup } from "@/services/connection-prompt-session";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import routes from "./connection-prompt-session.routes";

// The real cache, stored in this file's test database.
setupTestCacheManager();

const PROMPT =
  "Read https://ai.example.com/connect.md?client=claude-code and connect Claude Code.";

describe("POST /api/connection-setups/prompt-session", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    app = createFastifyInstance();
    await app.register(authPlugin);
    registerAuditLogHook(app);
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  test("an anonymous caller cannot begin a setup window", async () => {
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
      response: null,
      headers: new Headers(),
    } as never);
    const set = vi.spyOn(cacheManager, "set");

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/prompt-session",
      headers: { origin: "https://ai.example.com" },
      payload: { clientId: "claude-code", origin: "https://ai.example.com" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("archestra_setup_");
    expect(response.body).not.toContain("archestra_con_");
    expect(response.body).not.toContain(PROMPT);
    expect(set).not.toHaveBeenCalled();
  });

  test("an authenticated member begins a window without a marker", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
      response: {
        user: { id: user.id },
        session: { id: "session-1", createdAt: new Date() },
      },
      headers: new Headers(),
    } as never);
    const set = vi.spyOn(cacheManager, "set");

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/prompt-session",
      headers: { origin: "https://ai.example.com" },
      payload: { clientId: "claude-code", origin: "https://ai.example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{ expiresAt: string }>();
    expect(Object.keys(body).sort()).toEqual(["expiresAt"]);
    expect(response.body).not.toContain("archestra_setup_");
    expect(response.body).not.toContain("archestra_con_");
    expect(JSON.stringify(set.mock.calls)).not.toContain("archestra_setup_");
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    const requestBody = {
      messages: [{ role: "user", content: PROMPT }],
    };
    expect(
      await recognizeConnectionSetup({
        userId: user.id,
        organizationId,
        sessionId: "native-a",
        clientId: "claude-code",
        requestBody,
      }),
    ).toBe(true);
    expect(requestBody).toEqual({
      messages: [{ role: "user", content: PROMPT }],
    });
    await vi.waitFor(async () => {
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        action: "connectionPromptSession.created",
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        action: "connectionPromptSession.created",
        actorType: "user",
        actorId: user.id,
        organizationId,
        resourceId: organizationId,
        before: null,
        after: { clientId: "claude-code", expiresAt: body.expiresAt },
      });
      const serialized = JSON.stringify(data[0]);
      expect(serialized).not.toContain("archestra_setup_");
      expect(serialized).not.toContain("archestra_con_");
      expect(serialized).not.toContain(PROMPT);
      expect(serialized).not.toContain("https://ai.example.com");
    });
  });

  test("the browser origin must match the prompt origin", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
      response: {
        user: { id: user.id },
        session: { id: "session-1", createdAt: new Date() },
      },
      headers: new Headers(),
    } as never);
    const set = vi.spyOn(cacheManager, "set");
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/prompt-session",
      headers: { origin: "https://ai.example.com" },
      payload: { clientId: "claude-code", origin: "https://elsewhere.example" },
    });
    expect(response.statusCode).toBe(400);
    expect(
      set.mock.calls.filter(([key]) =>
        String(key).startsWith("connection-prompt-session-pending"),
      ),
    ).toHaveLength(0);
  });
});
