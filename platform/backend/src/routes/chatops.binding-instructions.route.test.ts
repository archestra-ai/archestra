import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { ChatOpsChannelBindingModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import chatopsRoutes from "./chatops";

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: vi.fn(),
    getMSTeamsProvider: vi.fn(() => null),
    getSlackProvider: vi.fn(() => null),
    getTelegramProvider: vi.fn(() => null),
    processMessage: vi.fn(),
    getAccessibleChatopsAgents: vi.fn(),
  },
}));

/**
 * Route-level coverage for the per-channel instructions field on
 * `PATCH /api/chatops/bindings/:id`.
 */
describe("PATCH /api/chatops/bindings/:id — channel instructions", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(chatopsRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function makeBinding(channelInstructions?: string) {
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: `C${crypto.randomUUID().slice(0, 10)}`,
      workspaceId: `T${crypto.randomUUID().slice(0, 10)}`,
      channelName: "incident-response",
    });
    if (channelInstructions !== undefined) {
      await ChatOpsChannelBindingModel.update(binding.id, {
        channelInstructions,
      });
    }
    return binding;
  }

  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/chatops/bindings/${id}`,
      payload,
    });

  test("saves the instructions and returns them on the binding", async () => {
    const binding = await makeBinding();

    const response = await patch(binding.id, {
      channelInstructions:
        "  Every message here is a task — create it immediately.  ",
    });

    expect(response.statusCode).toBe(200);
    // Trimmed on the way in, so leading/trailing whitespace never reaches the
    // model as part of the instructions.
    expect(response.json().channelInstructions).toBe(
      "Every message here is a task — create it immediately.",
    );
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))
        ?.channelInstructions,
    ).toBe("Every message here is a task — create it immediately.");
  });

  test("clearing the field stores null, so 'cleared' and 'never set' are the same state", async () => {
    const binding = await makeBinding("Never quote prices.");

    for (const cleared of ["", "   ", null]) {
      const response = await patch(binding.id, {
        channelInstructions: cleared,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().channelInstructions).toBeNull();
    }
  });

  test("an update that omits the field leaves the instructions alone", async () => {
    const binding = await makeBinding("Never quote prices.");

    const response = await patch(binding.id, { answerAllMessages: true });

    expect(response.statusCode).toBe(200);
    expect(response.json().channelInstructions).toBe("Never quote prices.");
  });

  test("rejects instructions past the length limit rather than truncating them", async () => {
    const binding = await makeBinding();

    const response = await patch(binding.id, {
      channelInstructions: "x".repeat(4001),
    });

    expect(response.statusCode).toBe(400);
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))
        ?.channelInstructions,
    ).toBeNull();
  });

  test("refuses a binding belonging to another organization", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreign = await ChatOpsChannelBindingModel.create({
      organizationId: otherOrg.id,
      provider: "slack",
      channelId: `C${crypto.randomUUID().slice(0, 10)}`,
      workspaceId: `T${crypto.randomUUID().slice(0, 10)}`,
    });

    const response = await patch(foreign.id, {
      channelInstructions: "Should not stick.",
    });

    expect(response.statusCode).toBe(404);
    expect(
      (await ChatOpsChannelBindingModel.findById(foreign.id))
        ?.channelInstructions,
    ).toBeNull();
  });

  test("records the change in the audit log with a non-empty before/after diff", async () => {
    const binding = await makeBinding("Never quote prices.");

    const response = await patch(binding.id, {
      channelInstructions: "Route billing questions to the finance rota.",
    });
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, binding.id));
    expect(row).toBeDefined();
    expect(
      (row.before as { channelInstructions?: string } | null)
        ?.channelInstructions,
    ).toBe("Never quote prices.");
    expect(
      (row.after as { channelInstructions?: string } | null)
        ?.channelInstructions,
    ).toBe("Route billing questions to the finance rota.");
  });
});
