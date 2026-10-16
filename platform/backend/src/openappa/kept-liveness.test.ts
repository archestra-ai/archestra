import { randomBytes, randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { afterEach, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import OpenAppaPolicyFileModel from "@/models/openappa-policy-file";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";

/** Reading activity can fail like a storage outage would; otherwise the real decoder runs. */
const runtime = vi.hoisted(() => ({ unreadable: false }));
vi.mock("@archestra/openappa-rs", async (importOriginal) => {
  const actual = await importOriginal<{
    openappaOpeningKeys: (batches: Buffer[]) => (string | null)[];
  }>();
  return {
    ...actual,
    openappaOpeningKeys: vi.fn((batches: Buffer[]) => {
      if (runtime.unreadable) throw new Error("storage unavailable");
      return actual.openappaOpeningKeys(batches);
    }),
  };
});
vi.mock("@/logging");

const DAY_MS = 24 * 60 * 60 * 1000;

describe("annotators kept for conversations that are still active", () => {
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.openappa.enabled = true;
    config.openappa.keptAnnotatorHorizonDays = 30;
    runtime.unreadable = false;
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    organizationId = (await makeOrganization()).id;
    userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a renamed annotator stays kept while a conversation under the old policy was active, and says until when", async () => {
    await declare(urlJudged("a", JUDGE_A));
    const opening = await openedUnder({ activeDaysAgo: 2 });

    await declare(urlJudged("b", JUDGE_B));

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.content).toContain("a.tool-call");
    const kept = effective.retainedAnnotators?.kept ?? [];
    expect(kept).toMatchObject([
      {
        name: "a.tool-call",
        binding: JUDGE_A,
        openingHashes: [opening.hash],
        liveRoots: 1,
        lastActivityAt: opening.activeAt.toISOString(),
      },
    ]);
    expect(effective.retainedAnnotators?.recheckAt).toBe(
      new Date(opening.activeAt.getTime() + 30 * DAY_MS).toISOString(),
    );
    const view =
      await openappaBatteriesService.effectivePolicyView(organizationId);
    expect(view).not.toHaveProperty("retainedAnnotators");
    expect(view.retained?.kept).toEqual([
      {
        name: "a.tool-call",
        binding: JUDGE_A,
        liveRoots: 1,
        lastActivityAt: opening.activeAt,
        retiresAt: new Date(opening.activeAt.getTime() + 30 * DAY_MS),
      },
    ]);
  });

  test("an annotator no conversation needed within the horizon is no longer kept, and that is logged once", async () => {
    await declare(urlJudged("a", JUDGE_A));
    const opening = await openedUnder({ activeDaysAgo: 31 });

    await declare(urlJudged("b", JUDGE_B));

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.content).not.toContain("a.tool-call");
    expect(effective.retainedAnnotators).toMatchObject({
      kept: [],
      inactive: [
        {
          name: "a.tool-call",
          binding: JUDGE_A,
          openingHashes: [opening.hash],
        },
      ],
      recheckAt: null,
    });
    const retiredLines = () =>
      vi
        .mocked(logger.info)
        .mock.calls.filter(
          ([, message]) =>
            message ===
            "OpenAPPA no longer keeps annotators no conversation needed within the horizon",
        );
    expect(retiredLines()).toHaveLength(1);

    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(retiredLines()).toHaveLength(1);
  });

  test("conversations under policies that bound a removed name differently keep it at the binding of the most recently active one", async () => {
    await declare(urlJudged("b", JUDGE_B));
    const older = await openedUnder({
      activeDaysAgo: 3,
      content: urlJudged("a", JUDGE_A),
    });
    const newer = await openedUnder({
      activeDaysAgo: 1,
      content: urlJudged("a", JUDGE_A2),
    });
    vi.mocked(logger.warn).mockClear();

    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);

    expect(effective.lastError).toBeNull();
    expect(effective.content).toContain(JUDGE_A2);
    expect(effective.content).not.toContain(JUDGE_A);
    expect(effective.retainedAnnotators).toMatchObject({
      kept: [
        {
          name: "a.tool-call",
          binding: JUDGE_A2,
          openingHashes: [newer.hash],
          lastActivityAt: newer.activeAt.toISOString(),
        },
      ],
      dropped: [],
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      {
        organizationId,
        annotator: "a.tool-call",
        current: JUDGE_A2,
        earlier: [JUDGE_A],
      },
      "OpenAPPA earlier opening policies bound a kept annotator differently; sessions opened under them are answered by the binding it is kept at",
    );

    // The older conversation becomes the latest one: its binding is kept.
    await activity({ root: older.root, at: new Date() });
    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    const after =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(after.retainedAnnotators?.kept).toMatchObject([
      { name: "a.tool-call", binding: JUDGE_A, openingHashes: [older.hash] },
    ]);
  });

  test("an encrypted conversation keeps its opening annotator using recorded policy metadata", async () => {
    await declare(urlJudged("a", JUDGE_A));
    const opening = await openedUnder({ activeDaysAgo: 2, encrypted: true });
    await declare(urlJudged("b", JUDGE_B));
    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.content).toContain("a.tool-call");
    expect(effective.retainedAnnotators?.livenessKnown).toBe(true);
    expect(effective.retainedAnnotators?.kept).toMatchObject([
      { name: "a.tool-call", openingHashes: [opening.hash], liveRoots: 1 },
    ]);
  });

  test("the first read after the last conversation's horizon ends retires the annotator, although nothing else changed", async () => {
    await declare(urlJudged("a", JUDGE_A));
    await openedUnder({ activeDaysAgo: 29 });
    await declare(urlJudged("b", JUDGE_B));
    const kept =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(kept.content).toContain("a.tool-call");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const retired =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(retired.installFingerprint).toBe(kept.installFingerprint);
    expect(retired.content).not.toContain("a.tool-call");
    expect(
      retired.retainedAnnotators?.inactive.map(({ name }) => name),
    ).toEqual(["a.tool-call"]);
  });

  test("a conversation under a composition that carried the name without routing to it does not keep it", async () => {
    await declare(urlJudged("a", JUDGE_A));
    await openedUnder({ activeDaysAgo: 40 });
    await declare(urlJudged("b", JUDGE_B));
    // The idle policy is gone from the composition; open a session under the
    // composition that carried it a moment before.
    config.openappa.keptAnnotatorHorizonDays = 0;
    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    const carried =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(carried.content).toContain("a.tool-call");
    config.openappa.keptAnnotatorHorizonDays = 30;
    await openedUnder({ activeDaysAgo: 0, content: carried.content });

    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.content).not.toContain("a.tool-call");
  });

  test("activity that cannot be read keeps every candidate and looks again within the hour", async () => {
    await declare(urlJudged("a", JUDGE_A));
    await openedUnder({ activeDaysAgo: 31 });
    runtime.unreadable = true;
    // A conversation whose opening this process has not recorded yet.
    await activity({ root: randomUUID(), at: new Date() });

    await declare(urlJudged("b", JUDGE_B));

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.content).toContain("a.tool-call");
    expect(effective.retainedAnnotators?.livenessKnown).toBe(false);
    const record = effective.retainedAnnotators;
    expect(
      new Date(record?.recheckAt ?? 0).getTime() -
        new Date(record?.checkedAt ?? 0).getTime(),
    ).toBe(60 * 60 * 1000);
  });

  test("a horizon of 0 keeps the annotator however long its conversations are idle", async () => {
    config.openappa.keptAnnotatorHorizonDays = 0;
    await declare(urlJudged("a", JUDGE_A));
    await openedUnder({ activeDaysAgo: 400 });

    await declare(urlJudged("b", JUDGE_B));

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(effective.content).toContain("a.tool-call");
    expect(effective.retainedAnnotators?.recheckAt).toBeNull();
  });

  /**
   * Store the effective policy as the runtime does when a conversation opens
   * under it, with one operation `activeDaysAgo` days ago.
   */
  async function openedUnder(params: {
    activeDaysAgo: number;
    content?: string;
    encrypted?: boolean;
  }) {
    const content =
      params.content ??
      (await openappaBatteriesService.getEffectivePolicy(organizationId))
        .content;
    const hash = await OpenAppaPolicyFileModel.store(content);
    const root = randomUUID();
    // The root's first batch, as the runtime writes it when the root opens.
    await db.insert(schema.openappaEventsTable).values({
      root,
      seq: 0,
      payload: params.encrypted
        ? randomBytes(96)
        : Buffer.from(
            JSON.stringify([
              { TrajectoryOpened: { trajectory: root, policy_file_key: hash } },
            ]),
          ),
    });
    // Encrypted opening bytes are opaque to the keyless retention sweep. The
    // native dispatch records this non-content identity while it has the key.
    if (params.encrypted)
      await db.insert(schema.openappaRootOpeningsTable).values({
        root,
        organizationId,
        policyFileKey: hash,
      });
    const activeAt = new Date(
      Math.floor((Date.now() - params.activeDaysAgo * DAY_MS) / 1000) * 1000,
    );
    await activity({ root, at: activeAt });
    return { hash, root, activeAt };
  }

  /** One completed operation of a conversation of `root`, as the runtime records it. */
  async function activity(params: { root: string; at: Date }) {
    await db.insert(schema.openappaOperationsTable).values({
      organizationId,
      sessionId: `session-${params.root}`,
      operationId: randomUUID(),
      root: params.root,
      status: "complete",
      input: {},
      decision: {},
      createdAt: params.at,
    });
  }

  async function declare(content: string) {
    const latest = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId,
      content,
      expectedRevision: latest.revision,
    });
    await openappaBatteriesService.recompile(organizationId);
  }
});

const JUDGE_A = "https://judge-a.test/annotate";
const JUDGE_A2 = "https://judge-a2.test/annotate";
const JUDGE_B = "https://judge-b.test/annotate";

/** A root whose one URL-bound annotator `<prefix>.tool-call` judges every tool. */
function urlJudged(prefix: string, url: string): string {
  const name = `${prefix}.tool-call`;
  return `[policy]
version = 2

[[policy.annotator]]
name = "${name}"
ranks = ["suspicious", "trusted"]
audiences = ["self"]
marks = []

[[policy.tool]]
name = "*"
annotator = "${name}"

[externals.annotators."${name}"]
url = "${url}"
`;
}
