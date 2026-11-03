import { setImmediate } from "node:timers/promises";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { registerAuditLogHook } from "./audit-log-hook";
import { AUDITABLE_ROUTES } from "./audit-log-registry";

test("waits for an API audit snapshot started after shutdown before closing dependencies", async ({
  makeUser,
  makeOrganization,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  const app = createFastifyInstance();
  const gate = () => {
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    return { resolve, promise };
  };
  const entered = gate(),
    finishHandler = gate(),
    snapshotEntered = gate(),
    finishSnapshot = gate();
  let dependencyClosed = false;
  let snapshots = 0;
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = org.id;
  });
  AUDITABLE_ROUTES["/api/ha-audit/:id"] = {
    resourceType: "agent",
    action: "agent.created",
    fetchById: async (id) => {
      if (++snapshots === 1) return { id, name: "Before" };
      snapshotEntered.resolve();
      await finishSnapshot.promise;
      return { id, name: "Synthetic" };
    },
  };
  registerAuditLogHook(app);
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  app.post("/api/ha-audit/:id", async () => {
    entered.resolve();
    await finishHandler.promise;
    return { completed: true };
  });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = fetch(
      `${url}/api/ha-audit/00000000-0000-0000-0000-000000000001`,
      { method: "POST", headers: { Connection: "close" } },
    ).then((r) => r.json());
    await entered.promise;
    const closing = app.close();
    await setImmediate(); // let preClose observe no active LLM or background writes
    finishHandler.resolve();
    expect(await response).toEqual({ completed: true });
    await snapshotEntered.promise;
    await setImmediate();
    expect(dependencyClosed).toBe(false);
    expect(await db.select().from(schema.auditLogsTable)).toHaveLength(0);
    finishSnapshot.resolve();
    await closing;
    expect(dependencyClosed).toBe(true);
    await drainBackgroundWork();
    expect(await db.select().from(schema.auditLogsTable)).toHaveLength(1);
  } finally {
    finishHandler.resolve();
    finishSnapshot.resolve();
    await drainBackgroundWork();
    app.server.closeAllConnections();
    await app.close();
    delete AUDITABLE_ROUTES["/api/ha-audit/:id"];
  }
});
