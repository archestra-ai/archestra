import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ThroughputReceipt } from "@/models/llm-throughput";
import type { Limit } from "@/types/limit";

const databaseUrl = process.env.ARCHESTRA_LLM_LIMITS_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error(
    "Set ARCHESTRA_LLM_LIMITS_TEST_DATABASE_URL to a migrated disposable *_test database",
  );
}

type Admission =
  | { reservation: ThroughputReceipt | null }
  | { denied: { retryAfter: number; limitType: string } };
type Usage = [string, { currentUsage: number; resetsAt: string }][];
let sequence = 0;
const children: ReturnType<typeof fork>[] = [];
async function worker(skew = false) {
  const application = `llm-limits-${randomUUID()}`;
  const child = fork(
    fileURLToPath(new URL("./postgres-worker.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        ARCHESTRA_DATABASE_URL: databaseUrl,
        PGAPPNAME: application,
        QUOTA_PROCESS_CLOCK_SKEW: skew ? "yes" : "no",
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL("../../../standalone-scripts.tsconfig.json", import.meta.url),
        ),
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  children.push(child);
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let ready: (pid: number) => void;
  const started = new Promise<number>((resolve, reject) => {
    ready = resolve;
    const timeout = setTimeout(
      () => reject(new Error("PostgreSQL worker startup timed out")),
      30000,
    );
    timeout.unref();
    child.once("exit", () => clearTimeout(timeout));
  });
  child.on(
    "message",
    (message: {
      ready?: number;
      id: string;
      result?: unknown;
      error?: string;
    }) => {
      if (message.ready) {
        ready(message.ready);
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      message.error
        ? item.reject(new Error(message.error))
        : item.resolve(message.result);
    },
  );
  child.on("exit", () => {
    for (const item of pending.values())
      item.reject(new Error("PostgreSQL worker exited"));
    pending.clear();
  });
  function request<T>(
    id: string,
    operation: string,
    args: unknown,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${operation} timed out`));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.send({ id, operation, args });
    });
  }
  return {
    pid: await started,
    child,
    application,
    call: <T = unknown>(operation: string, args?: unknown) =>
      request<T>(String(++sequence), operation, args),
    async hold(ruleId: string) {
      const id = String(++sequence),
        gate = randomUUID();
      const locked = new Promise<unknown>((resolve, reject) =>
        pending.set(`${id}:locked`, { resolve, reject }),
      );
      const finished = request(id, "hold", { ruleId, gate });
      await locked;
      return async () => {
        await request(String(++sequence), "release", { gate });
        await finished;
      };
    },
  };
}
type Worker = Awaited<ReturnType<typeof worker>>;
let a: Worker, b: Worker, c: Worker;
const intervals = [
  "minute",
  "1h",
  "12h",
  "24h",
  "1w",
  "1m",
  "calendar_day",
  "calendar_week_sunday",
  "calendar_week_monday",
  "calendar_month",
] as const;
const counterKey = (rule: Limit) =>
  `keyv:llm-throughput-counter-${rule.limitType === "tokens" ? "actual-tokens-v1-" : ""}${rule.id}`;
const scope = (rules: Limit[]) =>
  rules.map((rule) => ({
    entityType: rule.entityType,
    entityId: rule.entityId,
  }));
const admit = (w: Worker, rules: Limit[], extra = {}) =>
  w.call<Admission>("admit", {
    entities: scope(rules),
    model: "model-a",
    ...extra,
  });
function receipt(value: Admission): ThroughputReceipt {
  assert(
    "reservation" in value && value.reservation,
    "Expected an admitted request with a receipt",
  );
  return value.reservation;
}
const charge = (w: Worker, admission: Admission, tokens: number) =>
  w.call("reconcile", { reservation: receipt(admission), tokens });
async function create(
  kind: "requests" | "tokens" | "token_cost",
  interval: (typeof intervals)[number],
  capacity: number,
  entityType: "team" | "virtual_key" = "team",
  model: string[] | null = null,
) {
  return a.call<Limit>("create", {
    entityType,
    entityId: randomUUID(),
    limitType: kind,
    cleanupInterval: interval,
    limitValue: capacity,
    model,
  });
}
async function used(rule: Limit) {
  return (
    new Map(await a.call<Usage>("usage", [rule])).get(rule.id)?.currentUsage ??
    0
  );
}
async function age(rule: Limit, millis: number) {
  const raw = await a.call<string>("get", { key: counterKey(rule) });
  const value = JSON.parse(raw);
  value.value.updatedAt -= millis;
  await a.call("set", { key: counterKey(rule), value: JSON.stringify(value) });
}
async function waiting(w: Worker) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await a.call("waiting", { application: w.application })) return;
    await delay(10);
  }
  throw new Error(
    "Expected the replica to wait on the production advisory lock",
  );
}
before(async () => {
  a = await worker();
  b = await worker(true);
  c = await worker();
  assert.equal(new Set([a.pid, b.pid, c.pid]).size, 3);
  await a.call("setup");
  process.stdout.write(
    `Real PostgreSQL replica worker PIDs: ${a.pid}, ${b.pid}, ${c.pid}\n`,
  );
});
after(() => {
  for (const child of children) child.kill();
});

for (const interval of intervals) {
  test(`actual-token sums, overshoot and duplicate reports across replicas: ${interval}`, async () => {
    const rule = await create("tokens", interval, 100);
    const admitted = await Promise.all([admit(a, [rule]), admit(b, [rule])]);
    assert.equal(await used(rule), 0);
    await Promise.all(admitted.map((value, i) => charge(i ? b : a, value, 80)));
    const actual = await used(rule);
    assert(actual > 155 && actual <= 160);
    const denied = await admit(c, [rule]);
    assert("denied" in denied);
    assert.equal(denied.denied.limitType, "tokens");
    assert(denied.denied.retryAfter > 0);
    await Promise.all(admitted.map((value) => charge(c, value, 9999)));
    assert((await used(rule)) <= actual);
  });
  test(`last-request-slot admission is atomic across replicas: ${interval}`, async () => {
    const rule = await create("requests", interval, 1);
    const values = await Promise.all(
      Array.from({ length: 18 }, (_, i) => admit(i % 2 ? a : b, [rule])),
    );
    assert.equal(values.filter((value) => "reservation" in value).length, 1);
  });
}

test("parent denial is all-or-none across mixed token/request periods", async () => {
  const requests = await create("requests", "calendar_month", 2);
  const tokens = await create("tokens", "calendar_day", 100);
  const values = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      admit(i % 2 ? a : b, [requests, tokens]),
    ),
  );
  const accepted = values.filter((value) => "reservation" in value);
  assert.equal(accepted.length, 2);
  assert.equal(await used(requests), 2);
  assert.equal(await used(tokens), 0);
  await Promise.all(accepted.map((value) => charge(c, value, 70)));
  assert.equal(await used(tokens), 140);
});

test("all-model and selected-model limits accumulate without charging another model", async () => {
  const parent = await create("tokens", "calendar_day", 100);
  const model = await create("tokens", "calendar_month", 20, "virtual_key", [
    "model-a",
  ]);
  await charge(b, await admit(a, [parent, model]), 25);
  assert.equal(await used(parent), 25);
  assert.equal(await used(model), 25);
  const other = await admit(c, [model], { model: "model-b" });
  assert("reservation" in other && other.reservation === null);
});

test("subscriptions count tokens/requests but never accrue minute spend", async () => {
  const tokens = await create("tokens", "calendar_day", 100);
  const requests = await create("requests", "calendar_day", 10);
  const spend = await create("token_cost", "minute", 1);
  const admission = await admit(a, [tokens, requests, spend], {
    subscription: true,
  });
  await charge(b, admission, 15);
  await b.call("reconcile", {
    reservation: receipt(admission),
    tokens: 0,
    spend: 4,
  });
  assert.equal(await used(tokens), 15);
  assert.equal(await used(requests), 1);
  assert.equal(await used(spend), 0);
});

test("final metered classification charges a subscription receipt exactly once across processes", async () => {
  const spend = await create("token_cost", "minute", 1);
  const admission = await admit(a, [spend], { subscription: true });
  const settlement = {
    reservation: receipt(admission),
    tokens: 0,
    spend: 0.45,
    billingMode: "metered",
  };
  await Promise.all([
    b.call("reconcile", settlement),
    c.call("reconcile", settlement),
  ]);
  assert((await used(spend)) > 0.4);
  assert((await used(spend)) <= 0.45);
});

test("final subscription classification suppresses spend even for a metered admission", async () => {
  const spend = await create("token_cost", "minute", 1);
  const admission = await admit(a, [spend]);
  await b.call("reconcile", {
    reservation: receipt(admission),
    tokens: 0,
    spend: 4,
    billingMode: "subscription",
  });
  await c.call("reconcile", {
    reservation: receipt(admission),
    tokens: 0,
    spend: 4,
    billingMode: "metered",
  });
  assert.equal(await used(spend), 0);
});

test("actual minute spend preserves cents and over-cap debt", async () => {
  const rule = await create("token_cost", "minute", 1);
  const values = await Promise.all([admit(a, [rule]), admit(b, [rule])]);
  await Promise.all(
    values.map((value) =>
      c.call("reconcile", {
        reservation: receipt(value),
        tokens: 0,
        spend: 0.65,
      }),
    ),
  );
  assert((await used(rule)) > 1.2);
  const denied = await admit(b, [rule]);
  assert("denied" in denied);
  assert.equal(denied.denied.limitType, "token_cost");
});

test("minute recovery is gradual and governed by DB time despite a skewed process", async () => {
  const rule = await create("tokens", "minute", 60);
  await charge(b, await admit(a, [rule]), 120);
  const before = await used(rule);
  await delay(1100);
  const after = await used(rule);
  assert(before - after >= 1 && before - after < 4);
  const denied = await admit(b, [rule]);
  assert("denied" in denied);
  assert(denied.denied.retryAfter >= 55 && denied.denied.retryAfter <= 60);
  await age(rule, 120000);
  assert("reservation" in (await admit(b, [rule])));
});

test("cap changes preserve debt and queued admissions re-read the cap", async () => {
  const rule = await create("requests", "calendar_day", 10);
  for (let i = 0; i < 4; i++) receipt(await admit(a, [rule]));
  const release = await a.hold(rule.id);
  const patch = b.call<Limit>("patch", {
    id: rule.id,
    data: { limitValue: 3 },
  });
  await waiting(b);
  const admission = admit(c, [rule]);
  await waiting(c);
  await release();
  const edited = await patch;
  assert.equal(await used(edited), 4);
  assert("denied" in (await admission));
});

test("late actual usage belongs to the edited current period and is still once-only", async () => {
  const rule = await create("tokens", "calendar_day", 100);
  const value = await admit(a, [rule]);
  const changed = await b.call<Limit>("patch", {
    id: rule.id,
    data: { cleanupInterval: "calendar_month" },
  });
  await charge(c, value, 70);
  await charge(a, value, 70);
  assert.equal(await used(changed), 70);
});

test("pre-send cancellation is idempotent and cannot refund subsequent work", async () => {
  const rule = await create("requests", "calendar_day", 2);
  const cancelled = receipt(await admit(a, [rule]));
  receipt(await admit(b, [rule]));
  await Promise.all(
    [a, b].map((w) =>
      w.call("reconcile", {
        reservation: cancelled,
        tokens: 0,
        cancelBeforeSend: true,
      }),
    ),
  );
  assert.equal(await used(rule), 1);
  receipt(await admit(c, [rule]));
  await a.call("reconcile", {
    reservation: cancelled,
    tokens: 0,
    cancelBeforeSend: true,
  });
  assert.equal(await used(rule), 2);
});

test("receipts survive a reporting-worker restart and deduplicate replay", async () => {
  const rule = await create("tokens", "calendar_day", 100);
  const value = await admit(a, [rule]);
  c.child.kill();
  c = await worker();
  await charge(c, value, 40);
  await charge(b, value, 40);
  assert.equal(await used(rule), 40);
});

test("storage failure rolls back receipt consumption so the actual report can be retried once", async () => {
  const rule = await create("tokens", "calendar_day", 100);
  const value = await admit(a, [rule]);
  const key = counterKey(rule);
  const valid = await a.call<string>("get", { key });
  const corrupt = JSON.parse(valid);
  corrupt.value.count = -1;
  await a.call("set", { key, value: JSON.stringify(corrupt) });
  await assert.rejects(charge(b, value, 20));
  await a.call("set", { key, value: valid });
  await charge(c, value, 20);
  await charge(b, value, 20);
  assert.equal(await used(rule), 20);
});

test("a report after receipt expiry does not invent or resurrect usage", async () => {
  const rule = await create("tokens", "calendar_day", 100);
  const value = await admit(a, [rule]);
  const key = `keyv:llm-throughput-receipt-actual-v1-${receipt(value).id}`;
  const raw = JSON.parse(await a.call<string>("get", { key }));
  raw.value.expiresAt = 1;
  raw.expires = 1;
  await a.call("set", { key, value: JSON.stringify(raw) });
  await charge(b, value, 30);
  await charge(c, value, 30);
  assert.equal(await used(rule), 0);
});

test("zero actual usage consumes the receipt without charging or allowing a later duplicate", async () => {
  const rule = await create("tokens", "calendar_day", 100);
  const value = await admit(a, [rule]);
  await charge(b, value, 0);
  await charge(c, value, 90);
  assert.equal(await used(rule), 0);
});

for (const mode of ["delete", "deleteMany", "deleteForEntity"] as const) {
  test(`${mode} waits for the quota lock and late reports cannot recreate a counter`, async () => {
    const rule = await create("tokens", "calendar_day", 100);
    const value = await admit(a, [rule]);
    await charge(b, await admit(b, [rule]), 30);
    const release = await a.hold(rule.id);
    let deleted = false;
    const args =
      mode === "deleteMany"
        ? [rule.id]
        : mode === "deleteForEntity"
          ? { entityType: rule.entityType, entityId: rule.entityId }
          : { id: rule.id };
    const deletion = b.call(mode, args).then((result) => {
      deleted = true;
      return result;
    });
    try {
      await waiting(b);
      assert.equal(
        deleted,
        false,
        "Deletion must serialize with admission/reporting",
      );
    } finally {
      await release();
    }
    const result = await deletion;
    if (mode === "delete") assert.equal(result, true);
    if (mode === "deleteMany") assert.deepEqual(result, [rule.id]);
    await charge(c, value, 70);
    assert.equal(await a.call("get", { key: counterKey(rule) }), undefined);
  });
}

test("an unrelated entity is not blocked by another rule's advisory lock", async () => {
  const locked = await create("requests", "calendar_day", 1);
  const unrelated = await create("requests", "calendar_day", 1);
  const release = await a.hold(locked.id);
  try {
    receipt(await admit(b, [unrelated]));
  } finally {
    await release();
  }
});
