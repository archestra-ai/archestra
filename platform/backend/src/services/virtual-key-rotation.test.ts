import { vi } from "vitest";
import { AuditLogModel, VirtualApiKeyModel } from "@/models";
import SecretModel from "@/models/secret";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { rotateDueVirtualKeys } from "./virtual-key-rotation";

const HOUR_MS = 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;

describe("rotateDueVirtualKeys", () => {
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    organizationId = (await makeOrganization()).id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeKey = (params: {
    name: string;
    rotation?: { intervalSeconds: number; gracePeriodSeconds: number };
    expiresAt?: Date;
  }) =>
    VirtualApiKeyModel.create({
      organizationId,
      name: params.name,
      keyType: "passthrough",
      scope: "personal",
      rotation: params.rotation,
      expiresAt: params.expiresAt,
    });

  test("rotates due keys with their grace period and leaves the rest", async () => {
    const due = await makeKey({
      name: "Due",
      rotation: { intervalSeconds: DAY_SECONDS, gracePeriodSeconds: 3600 },
    });
    const notDue = await makeKey({
      name: "Weekly",
      rotation: { intervalSeconds: 7 * DAY_SECONDS, gracePeriodSeconds: 3600 },
    });
    const manual = await makeKey({ name: "Manual only" });

    vi.setSystemTime(Date.now() + 25 * HOUR_MS);
    expect(await rotateDueVirtualKeys()).toMatchObject({ rotated: 1 });

    const rotated = await VirtualApiKeyModel.findById(due.virtualKey.id);
    expect(rotated).toMatchObject({
      rotationCount: 1,
      previousTokenStart: due.virtualKey.tokenStart,
    });
    expect(rotated?.tokenStart).not.toBe(due.virtualKey.tokenStart);
    // The next rotation is one interval after this one.
    expect(rotated?.nextRotationAt?.getTime()).toBeCloseTo(
      Date.now() + DAY_SECONDS * 1000,
      -4,
    );
    for (const untouched of [notDue, manual]) {
      expect(
        (await VirtualApiKeyModel.findById(untouched.virtualKey.id))
          ?.rotationCount,
      ).toBe(0);
    }

    // The old value works through the grace period, then stops.
    expect(await VirtualApiKeyModel.validateToken(due.value)).not.toBeNull();
    vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    expect(await VirtualApiKeyModel.validateToken(due.value)).toBeNull();

    // A run is idempotent: nothing is due again yet.
    expect(await rotateDueVirtualKeys()).toMatchObject({ rotated: 0 });
  });

  test("records automatic rotations as system actions", async () => {
    const due = await makeKey({
      name: "Audited",
      rotation: { intervalSeconds: DAY_SECONDS, gracePeriodSeconds: 0 },
    });
    vi.setSystemTime(Date.now() + 25 * HOUR_MS);

    await rotateDueVirtualKeys();

    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "virtualApiKey",
      limit: 10,
      offset: 0,
    });
    expect(data).toEqual([
      expect.objectContaining({
        action: "virtualApiKey.rotated",
        actorType: "system",
        resourceId: due.virtualKey.id,
        before: expect.objectContaining({ rotationCount: 0 }),
        after: expect.objectContaining({ rotationCount: 1 }),
      }),
    ]);
  });

  test("skips expired keys", async () => {
    const expiring = await makeKey({
      name: "Expiring",
      rotation: { intervalSeconds: DAY_SECONDS, gracePeriodSeconds: 0 },
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    vi.setSystemTime(Date.now() + 25 * HOUR_MS);

    expect(await rotateDueVirtualKeys()).toMatchObject({ rotated: 0 });
    expect(
      (await VirtualApiKeyModel.findById(expiring.virtualKey.id))
        ?.rotationCount,
    ).toBe(0);
  });

  test("removes rotated-out values once their grace period ends", async () => {
    const { virtualKey } = await makeKey({ name: "Rotated by hand" });
    await VirtualApiKeyModel.rotate({
      id: virtualKey.id,
      gracePeriodSeconds: 3600,
    });

    expect(await rotateDueVirtualKeys()).toMatchObject({ purged: 0 });
    expect(await SecretModel.findById(virtualKey.secretId)).not.toBeNull();

    vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    expect(await rotateDueVirtualKeys()).toMatchObject({ purged: 1 });
    expect(await VirtualApiKeyModel.findById(virtualKey.id)).toMatchObject({
      previousSecretId: null,
      previousTokenStart: null,
      previousTokenExpiresAt: null,
    });
    expect(await SecretModel.findById(virtualKey.secretId)).toBeNull();
  });
});
