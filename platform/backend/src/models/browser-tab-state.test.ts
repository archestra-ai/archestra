import { describe, expect, test } from "@/test";
import BrowserTabStateModel from "./browser-tab-state";

describe("BrowserTabStateModel", () => {
  describe("get", () => {
    test("returns null when no state exists", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      const result = await BrowserTabStateModel.get(
        agent.id,
        user.id,
        "conv-1",
      );

      expect(result).toBeNull();
    });

    test("returns state after upsert", async ({ makeAgent, makeUser }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-1", {
        url: "https://example.com",
        tabIndex: 3,
      });

      const result = await BrowserTabStateModel.get(
        agent.id,
        user.id,
        "conv-1",
      );

      expect(result).not.toBeNull();
      expect(result?.url).toBe("https://example.com");
      expect(result?.tabIndex).toBe(3);
    });
  });

  describe("upsert", () => {
    test("creates new state", async ({ makeAgent, makeUser }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-1", {
        url: "https://example.com",
        tabIndex: 1,
      });

      const result = await BrowserTabStateModel.get(
        agent.id,
        user.id,
        "conv-1",
      );
      expect(result?.url).toBe("https://example.com");
      expect(result?.tabIndex).toBe(1);
    });

    test("updates existing state on conflict", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-1", {
        url: "https://example.com",
        tabIndex: 1,
      });

      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-1", {
        url: "https://updated.com",
        tabIndex: 2,
      });

      const result = await BrowserTabStateModel.get(
        agent.id,
        user.id,
        "conv-1",
      );
      expect(result?.url).toBe("https://updated.com");
      expect(result?.tabIndex).toBe(2);
    });

    test("different agents get different states for same isolation key", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent1 = await makeAgent();
      const agent2 = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent1.id, user.id, "conv-1", {
        url: "https://agent1.com",
        tabIndex: 1,
      });

      await BrowserTabStateModel.upsert(agent2.id, user.id, "conv-1", {
        url: "https://agent2.com",
        tabIndex: 2,
      });

      const result1 = await BrowserTabStateModel.get(
        agent1.id,
        user.id,
        "conv-1",
      );
      const result2 = await BrowserTabStateModel.get(
        agent2.id,
        user.id,
        "conv-1",
      );

      expect(result1?.url).toBe("https://agent1.com");
      expect(result1?.tabIndex).toBe(1);
      expect(result2?.url).toBe("https://agent2.com");
      expect(result2?.tabIndex).toBe(2);
    });
  });

  describe("delete", () => {
    test("removes existing state", async ({ makeAgent, makeUser }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-1", {
        url: "https://example.com",
        tabIndex: 1,
      });

      await BrowserTabStateModel.delete(agent.id, user.id, "conv-1");

      const result = await BrowserTabStateModel.get(
        agent.id,
        user.id,
        "conv-1",
      );
      expect(result).toBeNull();
    });

    test("does not throw for non-existent state", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await expect(
        BrowserTabStateModel.delete(agent.id, user.id, "non-existent"),
      ).resolves.not.toThrow();
    });

    test("does not affect other agents' states", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent1 = await makeAgent();
      const agent2 = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent1.id, user.id, "conv-1", {
        url: "https://agent1.com",
        tabIndex: 1,
      });
      await BrowserTabStateModel.upsert(agent2.id, user.id, "conv-1", {
        url: "https://agent2.com",
        tabIndex: 2,
      });

      await BrowserTabStateModel.delete(agent1.id, user.id, "conv-1");

      const result1 = await BrowserTabStateModel.get(
        agent1.id,
        user.id,
        "conv-1",
      );
      const result2 = await BrowserTabStateModel.get(
        agent2.id,
        user.id,
        "conv-1",
      );

      expect(result1).toBeNull();
      expect(result2?.url).toBe("https://agent2.com");
    });
  });

  describe("updateUrl", () => {
    test("updates url for existing state", async ({ makeAgent, makeUser }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-1", {
        url: "https://old.com",
        tabIndex: 1,
      });

      await BrowserTabStateModel.updateUrl(
        agent.id,
        user.id,
        "conv-1",
        "https://new.com",
      );

      const result = await BrowserTabStateModel.get(
        agent.id,
        user.id,
        "conv-1",
      );
      expect(result?.url).toBe("https://new.com");
      // tabIndex should remain unchanged
      expect(result?.tabIndex).toBe(1);
    });

    test("creates state if not exists", async ({ makeAgent, makeUser }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.updateUrl(
        agent.id,
        user.id,
        "conv-1",
        "https://new.com",
      );

      const result = await BrowserTabStateModel.get(
        agent.id,
        user.id,
        "conv-1",
      );
      expect(result?.url).toBe("https://new.com");
      expect(result?.tabIndex).toBeNull();
    });
  });

  describe("getOldestForUser", () => {
    test("returns null when no states exist", async ({ makeUser }) => {
      const user = await makeUser();

      const result = await BrowserTabStateModel.getOldestForUser(user.id);
      expect(result).toBeNull();
    });

    test("returns oldest state for user", async ({ makeAgent, makeUser }) => {
      const agent = await makeAgent();
      const user = await makeUser();

      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-1", {
        url: "https://first.com",
        tabIndex: 1,
      });
      await BrowserTabStateModel.upsert(agent.id, user.id, "conv-2", {
        url: "https://second.com",
        tabIndex: 2,
      });

      const result = await BrowserTabStateModel.getOldestForUser(user.id);
      expect(result).not.toBeNull();
      expect(result?.isolationKey).toBe("conv-1");
    });

    test("does not return states from other users", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent();
      const user1 = await makeUser();
      const user2 = await makeUser();

      await BrowserTabStateModel.upsert(agent.id, user1.id, "conv-1", {
        url: "https://user1.com",
        tabIndex: 1,
      });
      await BrowserTabStateModel.upsert(agent.id, user2.id, "conv-2", {
        url: "https://user2.com",
        tabIndex: 2,
      });

      const result = await BrowserTabStateModel.getOldestForUser(user1.id);
      expect(result).not.toBeNull();
      expect(result?.isolationKey).toBe("conv-1");
      expect(result?.url).toBe("https://user1.com");
    });
  });
});
