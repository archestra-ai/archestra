import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { openappaActor } from "./actor";
import { forkedSession } from "./lineage";

const organizationId = "org-lineage";
const scope = (session: string) => `user:alice|${session}`;

/** A session the native runtime has recorded, as its first event writes it. */
async function started(session: string, forkedFrom?: string) {
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(scope(session)),
    root: openappaActor(scope(session)),
    organizationId,
    callerId: "user:alice",
    sessionId: scope(session),
    forkedFrom: forkedFrom ? scope(forkedFrom) : null,
    startDecision: { decision: "ack" },
  });
}

const place = (sessionId: string, traced: string[]) =>
  forkedSession({ organizationId, sessionId, traced, scope });

describe("where a traced stamped history belongs", () => {
  test("a new session replaying another session's calls forks it", async () => {
    await started("parent");

    expect(await place("summarizer", ["parent"])).toBe("parent");
  });

  test("a session whose own calls are in its history continues itself", async () => {
    await started("parent");
    await started("fork", "parent");

    expect(await place("parent", ["parent"])).toBeUndefined();
    expect(await place("fork", ["parent", "fork"])).toBeUndefined();
  });

  test("a fork of a fork forks the session with the latest calls", async () => {
    await started("parent");
    await started("fork", "parent");

    expect(await place("grandchild", ["parent", "fork"])).toBe("fork");
  });

  test("a fork that has made no calls of its own yet keeps its parent", async () => {
    await started("parent");
    await started("fork", "parent");

    expect(await place("fork", ["parent"])).toBe("parent");
  });

  test("a history mixing unrelated sessions is refused", async () => {
    await started("first");
    await started("second");

    await expect(place("merged", ["first", "second"])).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("a session with a trajectory of its own never becomes a fork", async () => {
    await started("parent");
    await started("own");

    const refusal = await place("own", ["parent"]).catch((error) => error);

    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal.statusCode).toBe(409);
  });

  test("ignores a stamped session whose runtime never started", async () => {
    await started("parent");

    expect(await place("replaying", ["parent", "tool-less"])).toBe("parent");
  });
});
