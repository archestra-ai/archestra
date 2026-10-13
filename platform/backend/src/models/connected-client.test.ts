import { ConnectedClientModel, ConnectionSetupModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { ConnectionSetupClientId } from "@/types";

describe("ConnectedClientModel", () => {
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
  });

  test("lists one entry per redeemed client, ignoring unredeemed setups", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    const first = await redeem(user.id, "claude-code", "macos");
    await redeem(user.id, "claude-code", "linux");
    await redeem(user.id, "codex", "macos");
    await setup(user.id, "cursor");

    const clients = await ConnectedClientModel.listRedeemedForUser({
      organizationId,
      userId: user.id,
    });

    expect(clients.map((c) => c.clientId).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    const claude = clients.find((c) => c.clientId === "claude-code");
    // The latest setup describes the client; the first one dates it.
    expect(claude?.platform).toBe("linux");
    expect(claude?.connectedAt).toEqual(first.consumedAt);
    expect(claude?.lastConnectedAt.getTime()).toBeGreaterThanOrEqual(
      claude?.connectedAt.getTime() ?? 0,
    );
  });

  test("lists the distinct machines a client is connected on, most recent first", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    await redeem(user.id, "claude-code", "macos", "work-laptop");
    await redeem(user.id, "claude-code", "linux");
    await redeem(user.id, "claude-code", "macos", "home-mac");
    await redeem(user.id, "claude-code", "macos", "work-laptop");
    await redeem(user.id, "codex", "macos");

    const clients = await ConnectedClientModel.listRedeemedForUser({
      organizationId,
      userId: user.id,
    });

    const byId = new Map(clients.map((c) => [c.clientId, c]));
    expect(byId.get("claude-code")?.deviceNames).toEqual([
      "work-laptop",
      "home-mac",
    ]);
    expect(byId.get("codex")?.deviceNames).toEqual([]);
  });

  async function setup(userId: string, clientId: ConnectionSetupClientId) {
    const { setup: row, rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId,
      clientId,
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { row, rawToken };
  }

  async function redeem(
    userId: string,
    clientId: ConnectionSetupClientId,
    platform: "macos" | "linux",
    deviceName?: string,
  ) {
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId,
      clientId,
      platform,
      deviceName,
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Redeems in one millisecond tie on consumedAt, and the list orders by it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const claimed = await ConnectionSetupModel.claimByToken({ rawToken });
    if (!claimed) throw new Error("setup was not claimed");
    return claimed;
  }
});
