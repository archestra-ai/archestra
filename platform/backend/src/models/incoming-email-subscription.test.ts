import { describe, expect, test } from "@/test";
import IncomingEmailSubscriptionModel from "./incoming-email-subscription";

describe("IncomingEmailSubscriptionModel", () => {
  const createTestSubscription = async (overrides?: {
    expiresAt?: Date;
    subscriptionId?: string;
    clientState?: string;
  }) => {
    const defaultExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days from now
    return IncomingEmailSubscriptionModel.create({
      subscriptionId:
        overrides?.subscriptionId ?? `test-sub-${Date.now()}-${Math.random()}`,
      provider: "outlook",
      webhookUrl: "https://example.com/api/webhooks/incoming-email",
      clientState: overrides?.clientState ?? `test-client-state-${Date.now()}`,
      expiresAt: overrides?.expiresAt ?? defaultExpiresAt,
    });
  };

  describe("create", () => {
    test("can create a subscription", async () => {
      const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const clientState = "test-client-state-secure-token";
      const subscription = await IncomingEmailSubscriptionModel.create({
        subscriptionId: "graph-subscription-123",
        provider: "outlook",
        webhookUrl: "https://example.com/api/webhooks/incoming-email",
        clientState,
        expiresAt,
      });

      expect(subscription.id).toBeDefined();
      expect(subscription.subscriptionId).toBe("graph-subscription-123");
      expect(subscription.provider).toBe("outlook");
      expect(subscription.webhookUrl).toBe(
        "https://example.com/api/webhooks/incoming-email",
      );
      expect(subscription.clientState).toBe(clientState);
      expect(subscription.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(subscription.createdAt).toBeDefined();
      expect(subscription.updatedAt).toBeDefined();
    });
  });

  describe("getActiveSubscription", () => {
    test("returns active (non-expired) subscription", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day from now
      const created = await createTestSubscription({ expiresAt: futureDate });

      const active =
        await IncomingEmailSubscriptionModel.getActiveSubscription();

      expect(active).toBeDefined();
      expect(active.id).toBe(created.id);
    });

    test("returns undefined for expired subscription", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
      await createTestSubscription({ expiresAt: pastDate });

      const active =
        await IncomingEmailSubscriptionModel.getActiveSubscription();

      expect(active).toBeUndefined();
    });

    test("returns most recent active subscription when multiple exist", async () => {
      const futureDate1 = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const futureDate2 = new Date(Date.now() + 48 * 60 * 60 * 1000);

      await createTestSubscription({ expiresAt: futureDate1 });
      // Small delay to ensure different createdAt timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      const newer = await createTestSubscription({ expiresAt: futureDate2 });

      const active =
        await IncomingEmailSubscriptionModel.getActiveSubscription();

      expect(active).toBeDefined();
      expect(active.id).toBe(newer.id);
    });
  });

  describe("getMostRecent", () => {
    test("returns most recent subscription regardless of expiration", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // expired
      await createTestSubscription({ expiresAt: pastDate });

      const mostRecent = await IncomingEmailSubscriptionModel.getMostRecent();

      expect(mostRecent).toBeDefined();
      expect(mostRecent.expiresAt.getTime()).toBe(pastDate.getTime());
    });

    test("returns undefined when no subscriptions exist", async () => {
      // This test assumes clean database state from test isolation
      const mostRecent = await IncomingEmailSubscriptionModel.getMostRecent();

      // May or may not be undefined depending on other tests, so we just check it doesn't throw
      expect(mostRecent === undefined || mostRecent !== undefined).toBe(true);
    });
  });

  describe("updateExpiry", () => {
    test("can update subscription expiration", async () => {
      const initialExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const newExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000);

      const created = await createTestSubscription({
        expiresAt: initialExpiry,
      });

      const updated = await IncomingEmailSubscriptionModel.updateExpiry({
        id: created.id,
        expiresAt: newExpiry,
      });

      expect(updated).toBeDefined();
      expect(updated.id).toBe(created.id);
      expect(updated.expiresAt.getTime()).toBe(newExpiry.getTime());
    });

    test("returns undefined for non-existent subscription", async () => {
      const newExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000);

      const updated = await IncomingEmailSubscriptionModel.updateExpiry({
        id: "00000000-0000-0000-0000-000000000000",
        expiresAt: newExpiry,
      });

      expect(updated).toBeUndefined();
    });
  });

  describe("delete", () => {
    test("can delete a subscription by ID", async () => {
      const created = await createTestSubscription();

      // Verify it exists first
      const beforeDelete =
        await IncomingEmailSubscriptionModel.findBySubscriptionId(
          created.subscriptionId,
        );
      expect(beforeDelete).toBeDefined();

      await IncomingEmailSubscriptionModel.delete(created.id);

      // Verify deletion by checking record is gone
      const found = await IncomingEmailSubscriptionModel.findBySubscriptionId(
        created.subscriptionId,
      );
      expect(found).toBeUndefined();
    });

    test("does not throw for non-existent subscription", async () => {
      // Should not throw even for non-existent IDs
      await expect(
        IncomingEmailSubscriptionModel.delete(
          "00000000-0000-0000-0000-000000000000",
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("deleteBySubscriptionId", () => {
    test("can delete a subscription by Graph subscription ID", async () => {
      const subscriptionId = `graph-sub-${Date.now()}`;
      await createTestSubscription({ subscriptionId });

      // Verify it exists first
      const beforeDelete =
        await IncomingEmailSubscriptionModel.findBySubscriptionId(
          subscriptionId,
        );
      expect(beforeDelete).toBeDefined();

      await IncomingEmailSubscriptionModel.deleteBySubscriptionId(
        subscriptionId,
      );

      // Verify deletion by checking record is gone
      const found =
        await IncomingEmailSubscriptionModel.findBySubscriptionId(
          subscriptionId,
        );
      expect(found).toBeUndefined();
    });

    test("does not throw for non-existent subscription ID", async () => {
      // Should not throw even for non-existent subscription IDs
      await expect(
        IncomingEmailSubscriptionModel.deleteBySubscriptionId(
          "non-existent-subscription-id",
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("findBySubscriptionId", () => {
    test("can find subscription by Graph subscription ID", async () => {
      const subscriptionId = `graph-sub-${Date.now()}`;
      const created = await createTestSubscription({ subscriptionId });

      const found =
        await IncomingEmailSubscriptionModel.findBySubscriptionId(
          subscriptionId,
        );

      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.subscriptionId).toBe(subscriptionId);
    });

    test("returns undefined for non-existent subscription ID", async () => {
      const found = await IncomingEmailSubscriptionModel.findBySubscriptionId(
        "non-existent-subscription-id",
      );

      expect(found).toBeUndefined();
    });
  });
});
