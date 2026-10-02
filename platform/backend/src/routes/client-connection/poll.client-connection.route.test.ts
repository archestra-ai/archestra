import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import Keyv from "keyv";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import { createFastifyInstance } from "@/fastify-instance";
import routes from "./client-connection.routes";

class FaultStore extends EventEmitter {
  opts = {};
  failReads = false;
  private values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    if (this.failReads) {
      throw new Error(`ECONNRESET keyv:${key} device-secret`);
    }
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

const store = new FaultStore();
const injected = new Keyv({ store, throwOnErrors: true });
const manager = cacheManager as unknown as { keyv: Keyv | null };
let previous: Keyv | null;

beforeEach(() => {
  store.failReads = false;
  previous = manager.keyv;
  manager.keyv = injected;
});

afterEach(async () => {
  manager.keyv = previous;
  await store.clear();
});

function pollKey(deviceCode: string) {
  return `${CacheKey.ClientConnection}-poll-${createHash("sha256").update(deviceCode).digest("hex")}` as const;
}

test("a cache read fault after approval is unavailable, not expiry", async () => {
  const app = createFastifyInstance();
  await app.register(routes);
  try {
    const started = await app.inject({
      method: "POST",
      url: "/api/client-connections",
      payload: { clientId: "codex", platform: "linux" },
    });
    expect(started.statusCode).toBe(200);
    const { id, deviceCode, userCode, verificationPath } = started.json<{
      id: string;
      deviceCode: string;
      userCode: string;
      verificationPath: string;
    }>();
    expect(verificationPath).toContain(id);
    expect(verificationPath.match(/connectRequest=/g)).toHaveLength(1);

    const pending = await app.inject({
      method: "POST",
      url: "/api/client-connections/poll",
      payload: { deviceCode },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: "pending" });

    await cacheManager.set(
      pollKey(deviceCode),
      { status: "approved", expiresAt: Date.now() + 60_000 },
      60_000,
    );
    const approved = await app.inject({
      method: "POST",
      url: "/api/client-connections/poll",
      payload: { deviceCode },
    });
    expect(approved.json()).toEqual({ status: "approved" });

    store.failReads = true;
    const fault = await app.inject({
      method: "POST",
      url: "/api/client-connections/poll",
      payload: { deviceCode },
    });
    expect(fault.statusCode).toBe(503);
    expect(fault.body).not.toContain(deviceCode);
    expect(fault.body).not.toContain("client-connection");
    expect(fault.body).not.toContain("device-secret");
    expect(fault.json().status).toBeUndefined();
    expect(fault.json().error.message).not.toMatch(/expired/i);

    const page = await app.inject({ url: `/api/client-connections/${id}` });
    expect(page.statusCode).toBe(503);
    expect(page.body).not.toContain(id);
    expect(page.json().error.message).not.toMatch(/Start the installer again/);

    store.failReads = false;
    const again = await app.inject({
      method: "POST",
      url: "/api/client-connections/poll",
      payload: { deviceCode },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: "approved" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/client-connections/poll",
          payload: { deviceCode: "B".repeat(43) },
        })
      ).json(),
    ).toEqual({ status: "expired" });
    expect(userCode).toBe(`${id.slice(0, 4)}-${id.slice(4, 8)}`.toUpperCase());
  } finally {
    await app.close();
  }
});
