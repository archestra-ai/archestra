import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import McpDeploymentLeaseModel, {
  type ClusterLeaseGuard,
  ClusterLeaseHeldError,
  ClusterLeaseLostError,
} from "@/models/mcp-deployment-lease";
import { describe, expect, test } from "@/test";

const SCOPE = "lease-test";

async function readLease(key: string) {
  const [row] = await db
    .select()
    .from(schema.mcpDeploymentLeasesTable)
    .where(
      and(
        eq(schema.mcpDeploymentLeasesTable.scope, SCOPE),
        eq(schema.mcpDeploymentLeasesTable.key, key),
      ),
    );
  return row;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

describe("McpDeploymentLeaseModel.withLease", () => {
  test("one key has one holder at a time, and the lease frees on completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = McpDeploymentLeaseModel.withLease(
      { scope: SCOPE, key: "contended" },
      async () => {
        await gate;
        return "first";
      },
    );
    await waitFor(async () => (await readLease("contended")) !== undefined);

    // A second replica arriving mid-operation is refused without running.
    let secondRan = false;
    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "contended" },
        async () => {
          secondRan = true;
        },
      ),
    ).rejects.toThrow(ClusterLeaseHeldError);
    expect(secondRan).toBe(false);

    release();
    await expect(first).resolves.toBe("first");
    expect(await readLease("contended")).toBeUndefined();

    // Freed means claimable again.
    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "contended" },
        async () => "third",
      ),
    ).resolves.toBe("third");
  });

  test("a live foreign lease is refused and left untouched", async () => {
    await db.insert(schema.mcpDeploymentLeasesTable).values({
      scope: SCOPE,
      key: "foreign",
      holder: "another-replica",
      expiresAt: sql`now() + make_interval(secs => 60)`,
    });

    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "foreign" },
        async () => "never",
      ),
    ).rejects.toThrow(ClusterLeaseHeldError);
    expect((await readLease("foreign"))?.holder).toBe("another-replica");
  });

  test("an expired lease is claimable — a crashed holder cannot block forever", async () => {
    await db.insert(schema.mcpDeploymentLeasesTable).values({
      scope: SCOPE,
      key: "stale",
      holder: "crashed-replica",
      expiresAt: sql`now() - make_interval(secs => 1)`,
    });

    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "stale" },
        async () => "claimed",
      ),
    ).resolves.toBe("claimed");
    expect(await readLease("stale")).toBeUndefined();
  });

  test("a throwing operation still releases the lease", async () => {
    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "throwing" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(await readLease("throwing")).toBeUndefined();
  });

  test("a guard is invalidated when its lease callback ends", async () => {
    let captured!: ClusterLeaseGuard;
    await McpDeploymentLeaseModel.withLease(
      { scope: SCOPE, key: "ended" },
      async (guard) => {
        captured = guard;
      },
    );

    expect(captured.signal.aborted).toBe(true);
    expect(() => captured.throwIfLost()).toThrow(ClusterLeaseLostError);
    await expect(captured.runFencedMutation(async () => {})).rejects.toThrow(
      ClusterLeaseLostError,
    );
  });

  test("different keys do not contend", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = McpDeploymentLeaseModel.withLease(
      { scope: SCOPE, key: "key-a" },
      async () => {
        await gate;
      },
    );
    await waitFor(async () => (await readLease("key-a")) !== undefined);

    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "key-b" },
        async () => "parallel",
      ),
    ).resolves.toBe("parallel");

    release();
    await held;
  });

  test("a holder is fenced after its lease is replaced", async () => {
    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "fenced" },
        async (guard) => {
          await db
            .update(schema.mcpDeploymentLeasesTable)
            .set({
              holder: "replacement-holder",
              expiresAt: sql`now() + make_interval(secs => 60)`,
            })
            .where(
              and(
                eq(schema.mcpDeploymentLeasesTable.scope, SCOPE),
                eq(schema.mcpDeploymentLeasesTable.key, "fenced"),
              ),
            );

          await expect(guard.assertOwned()).rejects.toThrow(
            ClusterLeaseLostError,
          );
          expect(() => guard.throwIfLost()).toThrow(ClusterLeaseLostError);
          expect(guard.signal.aborted).toBe(true);
        },
      ),
    ).rejects.toThrow(ClusterLeaseLostError);
    expect((await readLease("fenced"))?.holder).toBe("replacement-holder");
  });

  test("an expired holder cannot enter a fenced mutation after a successor ran", async () => {
    let mutationRan = false;

    await expect(
      McpDeploymentLeaseModel.withLease(
        { scope: SCOPE, key: "mutation-fence" },
        async (guard) => {
          await db
            .update(schema.mcpDeploymentLeasesTable)
            .set({ expiresAt: sql`now() - make_interval(secs => 1)` })
            .where(
              and(
                eq(schema.mcpDeploymentLeasesTable.scope, SCOPE),
                eq(schema.mcpDeploymentLeasesTable.key, "mutation-fence"),
              ),
            );

          await McpDeploymentLeaseModel.withLease(
            { scope: SCOPE, key: "mutation-fence" },
            async () => "successor",
          );

          await guard.runFencedMutation(async () => {
            mutationRan = true;
          });
        },
      ),
    ).rejects.toThrow(ClusterLeaseLostError);
    expect(mutationRan).toBe(false);
  });

  test("waitUntilAvailable waits for a live holder and accepts expiry", async () => {
    await db.insert(schema.mcpDeploymentLeasesTable).values({
      scope: SCOPE,
      key: "waited",
      holder: "active-holder",
      expiresAt: sql`now() + make_interval(secs => 60)`,
    });

    const waiting = McpDeploymentLeaseModel.waitUntilAvailable({
      scope: SCOPE,
      key: "waited",
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    await db
      .update(schema.mcpDeploymentLeasesTable)
      .set({ expiresAt: sql`now() - make_interval(secs => 1)` })
      .where(
        and(
          eq(schema.mcpDeploymentLeasesTable.scope, SCOPE),
          eq(schema.mcpDeploymentLeasesTable.key, "waited"),
        ),
      );

    await expect(waiting).resolves.toBeUndefined();
  });

  test("withLeaseWhenAvailable waits and then acquires without running concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = McpDeploymentLeaseModel.withLease(
      { scope: SCOPE, key: "queued" },
      async () => gate,
    );
    await waitFor(async () => (await readLease("queued")) !== undefined);

    let secondRan = false;
    const second = McpDeploymentLeaseModel.withLeaseWhenAvailable(
      { scope: SCOPE, key: "queued", timeoutMs: 1_000 },
      async () => {
        secondRan = true;
        return "second";
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondRan).toBe(false);

    release();
    await first;
    await expect(second).resolves.toBe("second");
    expect(await readLease("queued")).toBeUndefined();
  });

  test("withLeaseWhenAvailable times out without running its operation", async () => {
    await db.insert(schema.mcpDeploymentLeasesTable).values({
      scope: SCOPE,
      key: "queued-timeout",
      holder: "another-replica",
      expiresAt: sql`now() + make_interval(secs => 60)`,
    });
    let ran = false;

    await expect(
      McpDeploymentLeaseModel.withLeaseWhenAvailable(
        { scope: SCOPE, key: "queued-timeout", timeoutMs: 10 },
        async () => {
          ran = true;
        },
      ),
    ).rejects.toThrow(ClusterLeaseHeldError);
    expect(ran).toBe(false);
  });
});
