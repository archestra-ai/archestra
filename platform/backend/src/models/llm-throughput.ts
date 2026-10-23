import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { Limit, LimitEntityType } from "@/types/limit";
import {
  readBucket,
  refundableCharge,
  type ThroughputBucket,
} from "@/utils/throughput-bucket";
import CacheEntryModel from "./cache-entry";

/** Once-only accounting receipt; only request-count capacity is reserved. */
export type ThroughputReceipt = {
  id: string;
  expiresAt: number;
  subscription?: boolean;
  limits: Array<{
    id: string;
    token: boolean;
    generation: string;
    released: number;
    amount: number;
    money?: boolean;
    epoch?: string;
    periodEnd?: number;
  }>;
};

type ThroughputAdmission =
  | { reservation: ThroughputReceipt | null }
  | {
      denied: {
        entityType: LimitEntityType;
        limitType: string;
        oversized: boolean;
        retryAfter: number | null;
      };
    };

/** Shared leaky buckets, capacity one minute's allowance; no request queue. */
class LlmThroughputModel {
  static async admit(params: {
    entities: Array<{ entityType: LimitEntityType; entityId: string }>;
    model: string;
    subscription?: boolean;
  }): Promise<ThroughputAdmission> {
    const rules = await LlmThroughputModel.findRules(params.entities);
    if (!rules.some((rule) => matchesModel(rule, params.model)))
      return { reservation: null };
    return CacheEntryModel.withLocks(
      rules.map((rule) => `llm-throughput:${rule.id}`),
      async (entries, tx) => {
        // Re-read after acquiring locks shared with edits: a queued admission
        // must not use an old cap. Rules created concurrently apply next call.
        const current = await LlmThroughputModel.findRules(params.entities, tx);
        const ids = new Set(rules.map((rule) => rule.id));
        const matching = current.filter(
          (rule) => ids.has(rule.id) && matchesModel(rule, params.model),
        );
        if (!matching.length) return { reservation: null };
        const now = await entries.now();
        const counters = await Promise.all(
          matching.map(async (rule) =>
            readBucket({
              raw: await entries.get(counterKey(rule)),
              now,
              capacity: rule.limitValue,
              ...period(rule),
            }),
          ),
        );
        const denials = matching.flatMap((rule, index) => {
          const money = rule.limitType === "token_cost";
          if (money && params.subscription) return [];
          const actualOnly = money || isToken(rule);
          const amount = actualOnly ? 0 : 1;
          const shortage = counters[index].count + amount - rule.limitValue;
          if (actualOnly ? shortage < 0 : shortage <= 0) return [];
          return [
            {
              entityType: rule.entityType,
              limitType: rule.limitType,
              oversized: false,
              retryAfter: counters[index].periodEnd
                ? Math.max(
                    1,
                    Math.ceil((counters[index].periodEnd - now) / 1000),
                  )
                : Math.max(1, Math.ceil((shortage * 60) / rule.limitValue)),
            },
          ];
        });
        if (denials.length) {
          // Persist elapsed drain (and one-time legacy conversion), never a
          // charge. Otherwise a denied legacy counter would restart its drain
          // clock on every retry and make Retry-After misleading.
          for (const [index, rule] of matching.entries()) {
            await entries.set(counterKey(rule), encodeBucket(counters[index]));
          }
          // Waiting must satisfy every applicable cap, not only the first one.
          const denied =
            denials.find((item) => item.limitType === "token_cost") ??
            denials.reduce((a, b) =>
              (a.retryAfter ?? 0) >= (b.retryAfter ?? 0) ? a : b,
            );
          return { denied };
        }
        const reservation: ThroughputReceipt = {
          id: randomUUID(),
          expiresAt: now + RECEIPT_TTL_MS,
          subscription: params.subscription ?? false,
          limits: matching.map((rule, index) => ({
            id: rule.id,
            token: isToken(rule),
            money: rule.limitType === "token_cost",
            epoch: counters[index].epoch,
            periodEnd: counters[index].periodEnd,
            generation: counters[index].generation,
            released: counters[index].released,
            amount: rule.limitType === "token_cost" || isToken(rule) ? 0 : 1,
          })),
        };
        for (const [index, rule] of matching.entries()) {
          counters[index].count += reservation.limits[index].amount;
          await entries.set(counterKey(rule), encodeBucket(counters[index]));
        }
        await entries.set(
          receiptKey(reservation.id),
          JSON.stringify({
            value: reservation,
            expires: reservation.expiresAt,
          }),
        );
        if (reservation.limits.some((rule) => rule.money))
          await entries.set(
            receiptKey(`${reservation.id}:spend`),
            JSON.stringify({
              value: reservation,
              expires: reservation.expiresAt,
            }),
          );
        return { reservation };
      },
    );
  }

  static async reconcile(params: {
    reservation: ThroughputReceipt;
    tokens: number;
    cancelBeforeSend?: boolean;
    billingMode?: "metered" | "subscription";
    /** Actual billed dollars, never an estimate or a token reservation. */
    spend?: number;
  }): Promise<void> {
    if (!Number.isSafeInteger(params.tokens) || params.tokens < 0)
      throw new Error("Invalid actual token usage");
    if (
      params.spend !== undefined &&
      (!Number.isFinite(params.spend) ||
        params.spend < 0 ||
        params.spend > Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Invalid actual spend");
    await CacheEntryModel.withLocks(
      params.reservation.limits.map((rule) => `llm-throughput:${rule.id}`),
      async (entries, tx) => {
        const receipts = await entries.take([
          receiptKey(
            `${params.reservation.id}${params.spend !== undefined ? ":spend" : ""}`,
          ),
          ...(params.cancelBeforeSend
            ? [receiptKey(`${params.reservation.id}:spend`)]
            : []),
        ]);
        if (!receipts.length) return;
        const stored: ThroughputReceipt = JSON.parse(receipts[0].value).value;
        const now = await entries.now();
        // Legacy receipts cannot refund a bucket from the new accounting model.
        if (!stored.expiresAt || now >= stored.expiresAt) return;
        const rules = await tx
          .select()
          .from(schema.limitsTable)
          .where(
            inArray(
              schema.limitsTable.id,
              stored.limits.map((rule) => rule.id),
            ),
          );
        for (const receipt of stored.limits.filter((rule) =>
          params.spend !== undefined
            ? rule.money &&
              (params.billingMode ??
                (stored.subscription ? "subscription" : "metered")) !==
                "subscription"
            : !rule.money && (rule.token || params.cancelBeforeSend),
        )) {
          const rule = rules.find((rule) => rule.id === receipt.id);
          if (!rule) continue;
          const key = counterKey(rule);
          const counter = readBucket({
            raw: await entries.get(key),
            now,
            capacity: rule.limitValue,
            ...period(rule),
          });
          // Actual tokens belong to the interval active when reported. Spend
          // and unsent request refunds retain their original-period contract.
          if (
            !receipt.token &&
            (receipt.epoch !== counter.epoch ||
              (receipt.periodEnd !== undefined &&
                (now >= receipt.periodEnd ||
                  receipt.generation !== counter.generation)))
          )
            continue;
          if (receipt.token && params.cancelBeforeSend) continue;
          const delta = params.spend ?? (receipt.token ? params.tokens : -1);
          if (delta < 0) {
            const refund = Math.min(
              -delta,
              counter.periodEnd !== undefined
                ? Math.min(counter.count, receipt.amount)
                : refundableCharge({
                    bucket: counter,
                    ...receipt,
                  }),
            );
            counter.count -= refund;
            counter.released += refund;
          } else {
            // Keep reported usage above the cap as debt. Concurrent calls can
            // finish after the allowance is exhausted; no tokens are forecast.
            if (delta > Number.MAX_SAFE_INTEGER - counter.count)
              throw new Error("Shared quota counter overflow");
            counter.count += delta;
          }
          if (
            !Number.isFinite(counter.count) ||
            counter.count > Number.MAX_SAFE_INTEGER
          )
            throw new Error("Shared quota counter overflow");
          await entries.set(key, encodeBucket(counter));
        }
      },
    );
  }

  /** Called under the same scoped lock as admission, inside the edit transaction. */
  static async reconfigure(params: {
    entries: CacheEntryModel;
    limit: Limit;
  }): Promise<void> {
    if (!isSharedRule(params.limit)) return;
    const key = counterKey(params.limit);
    const raw = await params.entries.get(key);
    if (!raw) return;
    const counter = readBucket({
      raw,
      now: await params.entries.now(),
      capacity: params.limit.limitValue,
      ...period(params.limit),
    });
    await params.entries.set(key, encodeBucket(counter));
  }

  /** Called while holding each rule's admission/reporting lock. */
  static async deleteCounters(entries: CacheEntryModel, rules: Limit[]) {
    await entries.take(rules.map(counterKey));
  }

  static async usage(limits: Limit[]) {
    const rules = limits.filter(isSharedRule);
    if (!rules.length)
      return new Map<string, { currentUsage: number; resetsAt: string }>();
    const clock = await db.execute<{ now: string }>(
      sql`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now`,
    );
    const now = Number(clock.rows[0].now);
    const rows = await CacheEntryModel.getMany(
      rules.map((rule) => counterKey(rule)),
    );
    const counters = new Map(rows.map((row) => [row.key, row.value]));
    return new Map(
      rules.map((rule) => {
        const counter = readBucket({
          raw: counters.get(counterKey(rule)),
          now,
          capacity: rule.limitValue,
          ...period(rule),
        });
        return [
          rule.id,
          {
            currentUsage: counter.count,
            // Wire name retained: projected full recovery without new calls,
            // not a configured reset or a wall-clock boundary.
            resetsAt: new Date(
              counter.periodEnd ??
                counter.updatedAt + (counter.count * 60000) / counter.rate,
            ).toISOString(),
          },
        ];
      }),
    );
  }

  /** Catch-all endpoints have no trustworthy inference/usage adapter. */
  static async hasRules(): Promise<boolean> {
    const rows = await db
      .select({ id: schema.limitsTable.id })
      .from(schema.limitsTable)
      .where(sharedRuleCondition())
      .limit(1);
    return rows.length > 0;
  }

  static async deleteExpired(): Promise<void> {
    // The periodic reaper drains bounded batches without blocking admission.
    await db.execute(sql`
      WITH expired AS (
        SELECT key FROM keyv_cache
        WHERE key LIKE 'keyv:llm-throughput-%'
          AND (value::jsonb ->> 'expires')::numeric <= extract(epoch FROM clock_timestamp()) * 1000
        ORDER BY key LIMIT 1000 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM keyv_cache USING expired WHERE keyv_cache.key = expired.key
    `);
  }

  private static async findRules(
    entities: Array<{ entityType: LimitEntityType; entityId: string }>,
    connection: Transaction | typeof db = db,
  ) {
    if (!entities.length) return [];
    return connection
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          sharedRuleCondition(),
          or(
            ...entities.map((entity) =>
              and(
                eq(schema.limitsTable.entityType, entity.entityType),
                eq(schema.limitsTable.entityId, entity.entityId),
              ),
            ),
          ),
        ),
      )
      .orderBy(schema.limitsTable.id);
  }
}

export default LlmThroughputModel;

const THROUGHPUT_TYPES = [
  "requests",
  "tokens",
  "requests_per_minute",
  "tokens_per_minute",
] as const;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
function matchesModel(rule: Limit, model: string) {
  return !rule.model?.length || rule.model.includes(model);
}
function counterKey(rule: Limit) {
  // Unshipped forecast counters are not actual usage. A separate token-only
  // namespace invalidates them once, without touching request/spend counters.
  return `keyv:llm-throughput-counter-${isToken(rule) ? "actual-tokens-v1-" : ""}${rule.id}`;
}
function receiptKey(id: string) {
  // Old forecast receipts must never alter actual usage after this revision.
  return `keyv:llm-throughput-receipt-actual-v1-${id}`;
}
function encodeBucket(value: ThroughputBucket) {
  const expires =
    value.periodEnd ?? value.updatedAt + (value.count * 60000) / value.rate + 1;
  if (!Number.isFinite(expires) || expires > 8640000000000000)
    throw new Error("Shared quota recovery time overflow");
  return JSON.stringify({
    value,
    expires,
  });
}
function isToken(rule: Limit) {
  return rule.limitType === "tokens" || rule.limitType === "tokens_per_minute";
}
function isSharedRule(rule: Limit) {
  return (
    THROUGHPUT_TYPES.some((type) => type === rule.limitType) ||
    (rule.limitType === "token_cost" && rule.cleanupInterval === "minute")
  );
}
function sharedRuleCondition() {
  return or(
    inArray(schema.limitsTable.limitType, THROUGHPUT_TYPES),
    and(
      eq(schema.limitsTable.limitType, "token_cost"),
      eq(schema.limitsTable.cleanupInterval, "minute"),
    ),
  );
}
function period(rule: Limit) {
  return {
    interval: rule.cleanupInterval,
    // Legacy minute buckets have no epoch until their first interval edit.
    epoch: rule.lastCleanup?.toISOString(),
    // New rolling periods start at creation until the first interval reset.
    anchor: (rule.lastCleanup ?? rule.createdAt).getTime(),
  };
}
