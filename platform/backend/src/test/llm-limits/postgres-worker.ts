import { sql } from "drizzle-orm";
import db, { initializeDatabase } from "@/database";
import CacheEntryModel from "@/models/cache-entry";
import LimitModel from "@/models/limit";
import LlmThroughputModel from "@/models/llm-throughput";
import type { CreateLimit, Limit, UpdateLimit } from "@/types/limit";

const url = new URL(process.env.ARCHESTRA_DATABASE_URL ?? "");
if (!url.pathname.endsWith("_test"))
  throw new Error("A disposable *_test database is required");
await initializeDatabase();
if (process.env.QUOTA_PROCESS_CLOCK_SKEW === "yes") {
  const actual = Date.now;
  Date.now = () => actual() + 3600000;
}
const held = new Map<string, () => void>();

type Request = { id: string; operation: string; args: unknown };
process.on("message", async ({ id, operation, args }: Request) => {
  try {
    let result: unknown;
    switch (operation) {
      case "setup":
        await db.execute(
          sql`CREATE TABLE IF NOT EXISTS keyv_cache(key VARCHAR(255) PRIMARY KEY, value TEXT)`,
        );
        break;
      case "create":
        result = await LimitModel.create(args as CreateLimit);
        break;
      case "patch": {
        const value = args as { id: string; data: Partial<UpdateLimit> };
        result = await LimitModel.patch(value.id, value.data);
        break;
      }
      case "delete":
        result = await LimitModel.delete((args as { id: string }).id);
        break;
      case "deleteMany":
        result = await LimitModel.deleteMany(args as string[]);
        break;
      case "deleteForEntity":
        result = await LimitModel.deleteForEntity(
          args as Parameters<typeof LimitModel.deleteForEntity>[0],
        );
        break;
      case "admit":
        result = await LlmThroughputModel.admit(
          args as Parameters<typeof LlmThroughputModel.admit>[0],
        );
        break;
      case "reconcile":
        await LlmThroughputModel.reconcile(
          args as Parameters<typeof LlmThroughputModel.reconcile>[0],
        );
        break;
      case "usage":
        result = [
          ...(await LlmThroughputModel.usage(
            (args as Limit[]).map((rule) => ({
              ...rule,
              createdAt: new Date(rule.createdAt),
              lastCleanup: rule.lastCleanup ? new Date(rule.lastCleanup) : null,
            })),
          )),
        ];
        break;
      case "time": {
        const rows = await db.execute(
          sql`SELECT clock_timestamp() AS now, pg_backend_pid() AS pid, version() AS version`,
        );
        result = rows.rows[0];
        break;
      }
      case "waiting": {
        const { application } = args as { application: string };
        const rows = await db.execute(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ${application}
            AND wait_event_type = 'Lock'
        ) AS waiting`);
        result = rows.rows[0]?.waiting;
        break;
      }
      case "get": {
        const { key } = args as { key: string };
        result = await CacheEntryModel.withLock(key, (entries) =>
          entries.get(key),
        );
        break;
      }
      case "set": {
        const { key, value } = args as { key: string; value: string };
        await CacheEntryModel.withLock(key, (entries) =>
          entries.set(key, value),
        );
        break;
      }
      case "hold": {
        const { ruleId, gate } = args as { ruleId: string; gate: string };
        await CacheEntryModel.withLock(`llm-throughput:${ruleId}`, async () => {
          process.send?.({ id: `${id}:locked`, result: true });
          await new Promise<void>((resolve) => held.set(gate, resolve));
          held.delete(gate);
        });
        break;
      }
      case "release":
        held.get((args as { gate: string }).gate)?.();
        break;
      case "cleanup":
        await LlmThroughputModel.deleteExpired();
        break;
      default:
        throw new Error(`Unknown test operation ${operation}`);
    }
    process.send?.({ id, result });
  } catch (error) {
    process.send?.({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
process.send?.({ ready: process.pid });
