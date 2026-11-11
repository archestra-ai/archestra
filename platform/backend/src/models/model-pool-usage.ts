import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import db from "@/database";
import logger from "@/logging";
import CacheEntryModel from "./cache-entry";

type Member = { memberId: string; providerApiKeyId: string; modelId: string };

/** Pool-only completed token usage, shared across replicas, in UTC calendar minutes.
 * This is a routing signal, not a provider quota or a Costs & Limits allowance.
 */
class ModelPoolUsageModel {
  static async read(
    poolId: string,
    members: Member[],
  ): Promise<Map<string, number>> {
    if (!members.length) return new Map();
    const keys = members.map((member) => key(poolId, member));
    // Routing is a hint, not admission: a single statement gives a consistent
    // snapshot without blocking completions or other replicas' selections.
    const result = await db
      .execute<{
        key: string;
        value: string;
        now: string;
      }>(sql`
      SELECT key, value, extract(epoch FROM statement_timestamp()) * 1000 AS now
      FROM keyv_cache WHERE key IN (${sql.join(
        keys.map((value) => sql`${value}`),
        sql`, `,
      )})
    `)
      .catch(() => {
        // A usage hint must never become a new hard allowance. Auth, health and
        // Costs & Limits still run on the normal dispatch path.
        logger.warn(
          "Unable to read model pool routing usage; choosing randomly",
        );
        return { rows: [] };
      });
    const minute = Math.floor(
      Number(result.rows[0]?.now ?? Date.now()) / 60_000,
    );
    const values = new Map(result.rows.map((row) => [row.key, row.value]));
    return new Map(
      members.map((member, index) => [
        member.memberId,
        decode(values.get(keys[index]), minute),
      ]),
    );
  }

  /** Bounded cleanup of removed pools/deployments, without blocking live rows. */
  static async deleteExpired(): Promise<void> {
    await db.execute(sql`
      WITH expired AS (
        SELECT key FROM keyv_cache
        WHERE key LIKE 'model-pool-usage:%'
          AND (value::jsonb ->> 'expires')::numeric <= extract(epoch FROM clock_timestamp()) * 1000
        ORDER BY key LIMIT 1000 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM keyv_cache USING expired WHERE keyv_cache.key = expired.key
    `);
  }

  static async record(params: {
    poolId: string;
    providerApiKeyId: string;
    modelId: string;
    tokens: number;
  }): Promise<void> {
    if (!Number.isSafeInteger(params.tokens) || params.tokens <= 0) return;
    await CacheEntryModel.withLock(
      key(params.poolId, params),
      async (entries) => {
        const minute = Math.floor((await entries.now()) / 60_000);
        const counterKey = key(params.poolId, params);
        const tokens =
          decode(await entries.get(counterKey), minute) + params.tokens;
        await entries.set(
          counterKey,
          JSON.stringify({
            value: { minute, tokens },
            expires: (minute + 2) * 60_000,
          }),
        );
      },
    );
  }
}

// Member rows are replaced when a pool is edited; the deployment identity survives.
function key(
  poolId: string,
  member: Pick<Member, "providerApiKeyId" | "modelId">,
) {
  const deployment = createHash("sha256")
    .update(JSON.stringify([member.providerApiKeyId, member.modelId]))
    .digest("hex");
  return `model-pool-usage:${poolId}:${deployment}`;
}

function decode(raw: string | undefined, minute: number): number {
  if (!raw) return 0;
  try {
    const value = JSON.parse(raw).value;
    if (
      !value ||
      !Number.isSafeInteger(value.minute) ||
      !Number.isSafeInteger(value.tokens) ||
      value.tokens < 0
    )
      throw new Error("Invalid counter");
    return value.minute === minute ? value.tokens : 0;
  } catch {
    // A subsequent completion overwrites malformed data instead of leaving
    // this pool unable to serve requests until manual cache repair.
    logger.warn("Ignoring invalid model pool routing usage");
    return 0;
  }
}

export default ModelPoolUsageModel;
