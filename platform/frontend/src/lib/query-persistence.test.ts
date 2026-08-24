import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPersistedQueryCache,
  PERSISTED_QUERY_META,
  restorePersistedQueryCache,
  startPersistingQueryCache,
  syncPersistedQueryCacheScope,
} from "./query-persistence";

const STORAGE_KEY = "archestra.refresh-cache.v1";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

async function seed(
  client: QueryClient,
  queryKey: unknown[],
  data: unknown,
  persist: boolean,
) {
  await client.fetchQuery({
    queryKey,
    queryFn: async () => data,
    meta: persist ? PERSISTED_QUERY_META : undefined,
  });
}

/** Force the debounced writer to flush. */
async function flushWrites() {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

describe("query persistence", () => {
  let client: QueryClient;
  let stop: () => void;

  beforeEach(() => {
    window.sessionStorage.clear();
    client = makeClient();
    stop = startPersistingQueryCache(client);
  });

  afterEach(() => {
    stop();
    client.clear();
    window.sessionStorage.clear();
  });

  it("restores only the queries that opted in", async () => {
    await seed(client, ["shell"], { name: "Acme" }, true);
    await seed(client, ["volatile"], { rows: [1, 2, 3] }, false);
    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();

    const restored = makeClient();
    restorePersistedQueryCache(restored);

    expect(restored.getQueryData(["shell"])).toEqual({ name: "Acme" });
    expect(restored.getQueryData(["volatile"])).toBeUndefined();
  });

  it("keeps credentials out of the snapshot", async () => {
    await seed(
      client,
      ["session"],
      { user: { email: "person@example.com" }, session: { token: "s3cret" } },
      true,
    );
    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();

    const raw = window.sessionStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).toContain("person@example.com");
    expect(raw).not.toContain("s3cret");
  });

  it("keeps permission resources whose names collide with credential fields", async () => {
    await seed(
      client,
      ["permissions"],
      { secret: ["read", "create"], apiKey: ["read"], token: ["read"] },
      true,
    );
    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();

    const restored = makeClient();
    restorePersistedQueryCache(restored);

    expect(restored.getQueryData(["permissions"])).toEqual({
      secret: ["read", "create"],
      apiKey: ["read"],
      token: ["read"],
    });
  });

  it("drops the snapshot when the same browser switches user or workspace", async () => {
    await seed(client, ["shell"], { name: "Acme" }, true);
    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();

    syncPersistedQueryCacheScope(client, "user-2:org-1");
    const restored = makeClient();
    restorePersistedQueryCache(restored);
    expect(restored.getQueryData(["shell"])).toBeUndefined();
  });

  it("keeps the snapshot when the scope is unchanged", async () => {
    await seed(client, ["shell"], { name: "Acme" }, true);
    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();

    syncPersistedQueryCacheScope(client, "user-1:org-1");
    const restored = makeClient();
    restorePersistedQueryCache(restored);
    expect(restored.getQueryData(["shell"])).toEqual({ name: "Acme" });
  });

  it("leaves nothing behind on sign-out", async () => {
    await seed(client, ["shell"], { name: "Acme" }, true);
    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();

    clearPersistedQueryCache();

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    const restored = makeClient();
    restorePersistedQueryCache(restored);
    expect(restored.getQueryData(["shell"])).toBeUndefined();
  });

  it("ignores a snapshot written by an older format", async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 0,
        scope: "user-1:org-1",
        savedAt: Date.now(),
        state: { queries: [], mutations: [] },
      }),
    );

    const restored = makeClient();
    restorePersistedQueryCache(restored);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("writes nothing until the scope is known", async () => {
    await seed(client, ["shell"], { name: "Acme" }, true);
    await flushWrites();

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("leaves a fetch in flight free to replace the restored value", async () => {
    await seed(client, ["shell"], { name: "Stale" }, true);
    syncPersistedQueryCacheScope(client, "user-1:org-1");
    await flushWrites();

    const restored = makeClient();
    const inFlight = restored.fetchQuery({
      queryKey: ["shell"],
      queryFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { name: "Fresh" };
      },
      meta: PERSISTED_QUERY_META,
    });

    restorePersistedQueryCache(restored);
    expect(restored.getQueryData(["shell"])).toEqual({ name: "Stale" });

    await inFlight;
    expect(restored.getQueryData(["shell"])).toEqual({ name: "Fresh" });
  });
});
