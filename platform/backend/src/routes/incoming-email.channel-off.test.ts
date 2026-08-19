import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type RestrictRoleResourceAccess,
  test,
} from "@/test";
import type { User } from "@/types";

vi.mock("@/agents/incoming-email", () => ({
  getEmailProvider: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  processIncomingEmail: vi.fn(),
}));

import {
  getEmailProvider,
  getSubscriptionStatus,
} from "@/agents/incoming-email";

/**
 * Turning the email channel off has to read as off on every surface, not only
 * where it is configured: the agent email address also backs the connect
 * instructions, where advertising an address the webhook refuses would be a
 * lie about what works.
 */
describe("incoming email while the channel is turned off", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let restrictAccess: RestrictRoleResourceAccess;

  beforeEach(
    async ({ makeOrganization, makeUser, restrictRoleResourceAccess }) => {
      vi.clearAllMocks();
      vi.mocked(getEmailProvider).mockReturnValue({
        providerId: "outlook",
        generateEmailAddress: (agentId: string) =>
          `agent-${agentId}@example.com`,
      } as unknown as ReturnType<typeof getEmailProvider>);

      user = await makeUser();
      const organization = await makeOrganization();
      organizationId = organization.id;
      restrictAccess = restrictRoleResourceAccess;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });
      const { default: incomingEmailRoutes } = await import("./incoming-email");
      await app.register(incomingEmailRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  // Every role, not just the caller's: the subscription-status route and the
  // webhook itself have no user to resolve a role against, so they ask whether
  // *any* role still allows the channel.
  const turnEmailOff = () =>
    restrictAccess(organizationId, { messagingChannels: ["slack"] });

  test("stops advertising an agent's email address", async ({ makeAgent }) => {
    const agent = await makeAgent({ organizationId, authorId: user.id });

    const before = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/email-address`,
    });
    expect(before.json()).toMatchObject({
      providerEnabled: true,
      emailAddress: `agent-${agent.id}@example.com`,
    });

    await turnEmailOff();

    const after = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/email-address`,
    });
    expect(after.json()).toMatchObject({
      providerEnabled: false,
      emailAddress: null,
    });
  });

  test("reports a live subscription as inactive", async () => {
    vi.mocked(getSubscriptionStatus).mockResolvedValue({
      id: "sub-row",
      subscriptionId: "graph-sub",
      provider: "outlook",
      webhookUrl: "https://example.com/hook",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      isActive: true,
    } as unknown as Awaited<ReturnType<typeof getSubscriptionStatus>>);

    const before = await app.inject({
      method: "GET",
      url: "/api/incoming-email/status",
    });
    expect(before.json().isActive).toBe(true);

    await turnEmailOff();

    const after = await app.inject({
      method: "GET",
      url: "/api/incoming-email/status",
    });
    // The subscription itself is still reported so an admin can see and remove
    // what is left behind.
    expect(after.json()).toMatchObject({
      isActive: false,
      subscription: { subscriptionId: "graph-sub" },
    });
  });

  test("refuses to set up a webhook subscription", async () => {
    await turnEmailOff();

    const response = await app.inject({
      method: "POST",
      url: "/api/incoming-email/setup",
      payload: { webhookUrl: "https://example.com/hook" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "not available to your role",
    );
  });
});
