import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import { ConfigCache, PROXY_CONFIG_TTL_MS } from "@/services/config-cache";
import { type PgClient, PostgresNotifyHub } from "@/services/pg-notify-hub";
import { RoutingPlanCache } from "@/services/routing-plan-cache";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { activeFit, makeScorerVersion } from "@/test/auto-routing";

/**
 * A listener session on the test database. Notifications are the database's
 * own: PGlite delivers them in-process to every session listening.
 */
class PgliteListenerClient implements PgClient {
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  private unlisten: (() => Promise<void>)[] = [];

  constructor(private readonly pglite: PGlite) {}

  async connect() {}

  async end() {
    await Promise.all(this.unlisten.map((stop) => stop()));
    this.emit("end");
  }

  async query(text: string, values?: unknown[]) {
    const listen = /^LISTEN "(.+)"$/.exec(text);
    if (!listen) return this.pglite.query(text, values);
    const channel = listen[1];
    this.unlisten.push(
      await this.pglite.listen(channel, (payload) =>
        this.emit("notification", { channel, payload }),
      ),
    );
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }

  private emit(event: string, ...args: unknown[]) {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
  }
}

describe("RoutingPlanCache", () => {
  let hubs: PostgresNotifyHub[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    hubs = [];
  });

  afterEach(async () => {
    await Promise.all(hubs.map((hub) => hub.close()));
    vi.useRealTimers();
  });

  function replica() {
    const pglite = db.$client as unknown as PGlite;
    const hub = new PostgresNotifyHub(
      "pglite://test",
      () => new PgliteListenerClient(pglite),
    );
    hubs.push(hub);
    return new RoutingPlanCache(new ConfigCache(hub));
  }

  /** Subscribe every replica, let delivery verify, pass the LISTEN settle window, then cache the empty plan. */
  async function becomeLive(
    replicas: RoutingPlanCache[],
    organizationId: string,
  ) {
    for (const cache of replicas) await cache.findActive(organizationId);
    await vi.waitFor(() =>
      expect(hubs.every((hub) => hub.deliveryGeneration() !== null)).toBe(true),
    );
    vi.setSystemTime(Date.now() + 2_001);
    for (const cache of replicas)
      expect(await cache.findActive(organizationId)).toBeNull();
  }

  test("a publication reaches every replica, and a lost notification is bounded by the TTL", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await AgentModel.getOrgLlmProxy(organization.id);
    const scorer = await makeScorerVersion();
    await AutoRoutingSettingsModel.activateScorerVersion(
      organization.id,
      scorer.id,
    );
    const settings = await AutoRoutingSettingsModel.find(organization.id);
    if (!settings) throw new Error("settings missing");
    const fit = (label: string, day: number) =>
      activeFit({
        organizationId: organization.id,
        scorerVersionId: scorer.id,
        generation: settings.generation,
        inputWatermark: new Date(Date.UTC(2026, 0, day)),
        label,
      });
    const a = replica();
    const b = replica();
    await becomeLive([a, b], organization.id);
    await RoutingPlanModel.publish(fit("first", 1));
    await vi.waitFor(async () =>
      expect((await a.findActive(organization.id))?.plan).toEqual({
        label: "first",
      }),
    );
    await vi.waitFor(async () =>
      expect((await b.findActive(organization.id))?.plan).toEqual({
        label: "first",
      }),
    );

    // A write whose notification is lost: both replicas keep serving their copy.
    const pglite = db.$client as unknown as PGlite;
    await pglite.exec(
      "ALTER TABLE routing_plans DISABLE TRIGGER archestra_notify_proxy_config",
    );
    await db
      .update(schema.routingPlansTable)
      .set({ plan: { label: "unnotified" } })
      .where(eq(schema.routingPlansTable.organizationId, organization.id));
    await pglite.exec(
      "ALTER TABLE routing_plans ENABLE TRIGGER archestra_notify_proxy_config",
    );
    expect((await a.findActive(organization.id))?.plan).toEqual({
      label: "first",
    });
    vi.setSystemTime(Date.now() + PROXY_CONFIG_TTL_MS + 1);
    expect((await a.findActive(organization.id))?.plan).toEqual({
      label: "unnotified",
    });

    await RoutingPlanModel.publish(fit("second", 2));
    for (const cache of [a, b]) {
      await vi.waitFor(async () =>
        expect((await cache.findActive(organization.id))?.plan).toEqual({
          label: "second",
        }),
      );
    }
  });
});
