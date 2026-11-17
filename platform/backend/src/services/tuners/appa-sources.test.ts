import { randomBytes } from "node:crypto";
import db, { schema } from "@/database";
import OpenAppaYellModel from "@/models/openappa-yell";
import { describe, expect, test } from "@/test";
import type { TunerCandidate, TunerCandidateSource } from "@/types/tuner";
import { collectAppaCandidates } from "./appa-sources";

describe("collectAppaCandidates", () => {
  test("flags a tool whose human reviews were approved 5 times and never denied", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    const approvals = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((hours) =>
        reviewed({ org, tool: "fs__read", ruling: "approve", hoursAgo: hours }),
      ),
    );
    for (const hours of [1, 2, 3, 4]) {
      await reviewed({
        org,
        tool: "fs__list",
        ruling: "approve",
        hoursAgo: hours,
      });
    }

    const found = await candidatesOf(org, "appa_hitl_approvals");

    expect(found).toEqual([
      expect.objectContaining({
        fingerprint: "appa_hitl_approvals:mcp/fs/read",
        severity: "info",
        evidence: approvals
          .slice(0, 5)
          .map((id) => ({ type: "openappa_consult", id })),
      }),
    ]);
  });

  test("a single denial, or a ruling whose answer was not stored, keeps a tool out of the approvals", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    for (const hours of [1, 2, 3, 4, 5]) {
      await reviewed({
        org,
        tool: "denied_once",
        ruling: "approve",
        hoursAgo: hours,
      });
      await reviewed({
        org,
        tool: "metadata_only",
        ruling: "approve",
        hoursAgo: hours,
      });
    }
    await reviewed({ org, tool: "denied_once", ruling: "deny", hoursAgo: 6 });
    await reviewed({ org, tool: "metadata_only", ruling: null, hoursAgo: 6 });

    expect(await candidatesOf(org, "appa_hitl_approvals")).toEqual([]);
  });

  test("flags a tool with 3 human denials, not one with 2", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    const denials = [];
    for (const hours of [1, 2, 3]) {
      denials.push(
        await reviewed({
          org,
          tool: "mail__send",
          ruling: "deny",
          hoursAgo: hours,
        }),
      );
      await reviewed({
        org,
        tool: "mail__draft",
        ruling: "approve",
        hoursAgo: hours,
      });
    }
    for (const hours of [1, 2]) {
      await reviewed({
        org,
        tool: "mail__draft",
        ruling: "deny",
        hoursAgo: hours,
      });
    }

    expect(await candidatesOf(org, "appa_hitl_denials")).toEqual([
      expect.objectContaining({
        fingerprint: "appa_hitl_denials:mcp/mail/send",
        severity: "warn",
        evidence: denials.map((id) => ({ type: "openappa_consult", id })),
      }),
    ]);
  });

  test("flags a tool the policy denied 5 times across 2 sessions", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    const recent = [];
    for (const [hours, session] of [
      [1, "s1"],
      [2, "s2"],
      [3, "s1"],
      [4, "s2"],
      [5, "s1"],
      [6, "s2"],
    ] as const) {
      recent.push(
        await denied({ org, tool: "db__drop", session, hoursAgo: hours }),
      );
    }
    for (const hours of [1, 2, 3, 4, 5, 6]) {
      await denied({
        org,
        tool: "one_session",
        session: "s1",
        hoursAgo: hours,
      });
    }
    for (const [hours, session] of [
      [1, "s1"],
      [2, "s2"],
      [3, "s1"],
      [4, "s2"],
    ] as const) {
      await denied({ org, tool: "four_times", session, hoursAgo: hours });
    }

    expect(await candidatesOf(org, "appa_repeated_denials")).toEqual([
      expect.objectContaining({
        fingerprint: "appa_repeated_denials:mcp/db/drop",
        severity: "warn",
        evidence: recent.slice(0, 5),
      }),
    ]);
  });

  test("counts only what happened within the last 14 days", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    for (const [hours, session] of [
      [1, "s1"],
      [2, "s2"],
      [3, "s1"],
      [4, "s2"],
    ] as const) {
      await denied({ org, tool: "inside", session, hoursAgo: hours });
      await denied({ org, tool: "outside", session, hoursAgo: hours });
    }
    await denied({ org, tool: "inside", session: "s1", hoursAgo: 14 * 24 - 1 });
    await denied({
      org,
      tool: "outside",
      session: "s1",
      hoursAgo: 14 * 24 + 1,
    });

    const found = await candidatesOf(org, "appa_repeated_denials");

    expect(found.map((c) => c.fingerprint)).toEqual([
      "appa_repeated_denials:host/archestra/inside",
    ]);
  });

  test("raises the severity one level at 4 times the threshold", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    for (let i = 0; i < 20; i++) {
      const session = i % 2 ? "s1" : "s2";
      await denied({ org, tool: "twenty", session, hoursAgo: i + 1 });
      if (i < 19)
        await denied({ org, tool: "nineteen", session, hoursAgo: i + 1 });
    }

    const found = await candidatesOf(org, "appa_repeated_denials");

    expect(
      found.map(({ fingerprint, severity }) => ({ fingerprint, severity })),
    ).toEqual([
      {
        fingerprint: "appa_repeated_denials:host/archestra/twenty",
        severity: "critical",
      },
      {
        fingerprint: "appa_repeated_denials:host/archestra/nineteen",
        severity: "warn",
      },
    ]);
  });

  test("flags 5 stock auto-approvals of a tool, counting those whose answer was not stored", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    const recent = [];
    for (const hours of [1, 2, 3, 4, 5]) {
      recent.push(
        await autoApproved({
          org,
          tool: "host/claude-code/Bash",
          hoursAgo: hours,
          metadataOnly: hours % 2 === 0,
        }),
      );
      if (hours < 5)
        await autoApproved({
          org,
          tool: "host/claude-code/Read",
          hoursAgo: hours,
        });
    }

    expect(await candidatesOf(org, "appa_observe_auto_approvals")).toEqual([
      expect.objectContaining({
        fingerprint: "appa_observe_auto_approvals:host/claude-code/Bash",
        severity: "info",
        evidence: recent.map((id) => ({ type: "openappa_consult", id })),
      }),
    ]);
  });

  test("groups unresolved waiver yells per tool, splitting comma-joined tools, and leaves resolved ones out", async ({
    makeOrganization,
    makeUser,
  }) => {
    const { id: org } = await makeOrganization();
    const user = await makeUser();
    const waive = (params: {
      session: string;
      kind: "approval_waived" | "block_waived";
      tool: string;
    }) =>
      OpenAppaYellModel.recordWaiver({
        organizationId: org,
        callerId: "user:1",
        sessionId: params.session,
        kind: params.kind,
        tool: params.tool,
        message: "let through",
        superyell: false,
      });
    await waive({
      session: "s1",
      kind: "block_waived",
      tool: "gh__push, gh__merge",
    });
    await waive({ session: "s2", kind: "approval_waived", tool: "gh__push" });
    await waive({ session: "s3", kind: "approval_waived", tool: "gh__close" });
    const resolved = await yellId(org, "s3");
    await OpenAppaYellModel.setResolved({
      organizationId: org,
      id: resolved,
      userId: user.id,
      resolved: true,
    });

    const found = await candidatesOf(org, "appa_unresolved_yell");

    expect(
      found.map(({ fingerprint, severity, evidence }) => ({
        fingerprint,
        severity,
        evidence: evidence.length,
      })),
    ).toEqual([
      {
        fingerprint: "appa_unresolved_yell:gh__push",
        severity: "info",
        evidence: 2,
      },
      {
        fingerprint: "appa_unresolved_yell:gh__merge",
        severity: "info",
        evidence: 1,
      },
    ]);
  });

  test("groups unresolved agent yells by caller", async ({
    makeOrganization,
    makeUser,
  }) => {
    const { id: org } = await makeOrganization();
    const user = await makeUser();
    const yell = (callerId: string, session: string) =>
      OpenAppaYellModel.record({
        organizationId: org,
        callerId,
        sessionId: session,
        toolCallId: `call-${session}`,
        message: "something is wrong",
        withTrajectory: false,
      });
    const first = await yell("user:1", "s1");
    const second = await yell("user:1", "s2");
    const other = await yell("user:2", "s3");
    const closed = await yell("user:2", "s4");
    await OpenAppaYellModel.setResolved({
      organizationId: org,
      id: closed.id,
      userId: user.id,
      resolved: true,
    });

    const byFingerprint = Object.fromEntries(
      (await candidatesOf(org, "appa_unresolved_yell")).map((c) => [
        c.fingerprint,
        new Set(
          c.evidence.flatMap((ref) =>
            ref.type === "openappa_yell" ? [ref.id] : [],
          ),
        ),
      ]),
    );
    expect(byFingerprint).toEqual({
      "appa_unresolved_yell:caller:user:1": new Set([first.id, second.id]),
      "appa_unresolved_yell:caller:user:2": new Set([other.id]),
    });
  });

  test("ignores rows sealed away from the database", async ({
    makeOrganization,
  }) => {
    const { id: org } = await makeOrganization();
    for (const hours of [1, 2, 3, 4, 5, 6]) {
      await denied({
        org,
        tool: "sealed",
        session: hours % 2 ? "s1" : "s2",
        hoursAgo: hours,
        sealed: true,
      });
      await autoApproved({
        org,
        tool: "sealed",
        hoursAgo: hours,
        sealed: true,
      });
    }

    expect(
      await collectAppaCandidates({ organizationId: org, now: new Date() }),
    ).toEqual({ candidates: [], complete: true });
  });

  test("ignores another organization's rows", async ({ makeOrganization }) => {
    const { id: org } = await makeOrganization();
    const { id: other } = await makeOrganization();
    for (const hours of [1, 2, 3, 4, 5, 6]) {
      const session = hours % 2 ? "s1" : "s2";
      await denied({ org: other, tool: "db__drop", session, hoursAgo: hours });
      await reviewed({
        org: other,
        tool: "fs__read",
        ruling: "approve",
        hoursAgo: hours,
      });
      await reviewed({
        org: other,
        tool: "mail__send",
        ruling: "deny",
        hoursAgo: hours,
      });
      await autoApproved({ org: other, tool: "host/x/y", hoursAgo: hours });
    }

    expect(
      await collectAppaCandidates({ organizationId: org, now: new Date() }),
    ).toEqual({ candidates: [], complete: true });
    expect(
      new Set(
        (
          await collectAppaCandidates({
            organizationId: other,
            now: new Date(),
          })
        ).candidates.map((c) => c.source),
      ),
    ).toEqual(
      new Set([
        "appa_repeated_denials",
        "appa_hitl_approvals",
        "appa_hitl_denials",
        "appa_observe_auto_approvals",
      ]),
    );
  });
});

// =============================================================================
// Helpers
// =============================================================================

async function candidatesOf(
  organizationId: string,
  source: TunerCandidateSource,
): Promise<TunerCandidate[]> {
  const { candidates } = await collectAppaCandidates({
    organizationId,
    now: new Date(),
  });
  return candidates.filter((candidate) => candidate.source === source);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/** As the runtime stores a value under encryption: opaque to SQL. */
const SEALED = { __appa_encrypted: "c2VhbGVk" };

/** A tool call the policy denied; returns its evidence ref. */
async function denied(params: {
  org: string;
  tool: string;
  session: string;
  hoursAgo: number;
  offers?: string[];
  sealed?: boolean;
}) {
  const operationId = `call:${crypto.randomUUID()}`;
  await db.insert(schema.openappaOperationsTable).values({
    organizationId: params.org,
    sessionId: params.session,
    operationId,
    root: "root",
    status: "complete",
    input: params.sealed
      ? SEALED
      : { semantic: { event: "tool_call", tool: params.tool } },
    decision: params.sealed
      ? SEALED
      : {
          decision: "deny_call",
          offers: (params.offers ?? []).map((offer_id) => ({ offer_id })),
        },
    createdAt: hoursAgo(params.hoursAgo),
  });
  return {
    type: "openappa_operation" as const,
    sessionId: params.session,
    operationId,
  };
}

/** A human review of a denied call's offer; returns the consult id. */
async function reviewed(params: {
  org: string;
  tool: string;
  /** Null: the answer was not stored (metadata-only logging). */
  ruling: "approve" | "deny" | null;
  hoursAgo: number;
}) {
  const offerId = canonicalOfferId();
  const session = `session-${params.hoursAgo}`;
  await denied({
    org: params.org,
    tool: params.tool,
    session,
    hoursAgo: params.hoursAgo + 0.5,
    offers: [offerId.slice(0, 16)],
  });
  return consult({
    org: params.org,
    session,
    hoursAgo: params.hoursAgo,
    backend: "hitl",
    request: {
      kind: "authority",
      artifact: {
        tool: "host/archestra/tool",
        arguments: {},
        requirements: [],
      },
    },
    answer: params.ruling === null ? null : { ruling: params.ruling },
    offerId,
  });
}

/** The engine's 64-hex offer digest; decisions render its first 16 characters. */
function canonicalOfferId(): string {
  return randomBytes(32).toString("hex");
}

/** An approval the stock `approve` authority gave; returns the consult id. */
async function autoApproved(params: {
  org: string;
  tool: string;
  hoursAgo: number;
  metadataOnly?: boolean;
  sealed?: boolean;
}) {
  const redacted = { __redacted: "log_content_policy" };
  const request = params.sealed
    ? SEALED
    : params.metadataOnly
      ? {
          ...redacted,
          kind: "authority",
          artifact: {
            tool: params.tool,
            arguments: redacted,
            requirements: [],
          },
        }
      : {
          kind: "authority",
          artifact: {
            tool: params.tool,
            arguments: { a: 1 },
            requirements: [],
          },
        };
  return consult({
    org: params.org,
    session: `session-${params.hoursAgo}`,
    hoursAgo: params.hoursAgo,
    backend: "stock",
    request,
    answer: params.metadataOnly || params.sealed ? null : { ruling: "approve" },
    offerId: `offer-${crypto.randomUUID()}`,
  });
}

async function consult(params: {
  org: string;
  session: string;
  hoursAgo: number;
  backend: "hitl" | "stock";
  request: unknown;
  answer: unknown;
  offerId: string;
}) {
  const id = crypto.randomUUID();
  const createdAt = hoursAgo(params.hoursAgo);
  await db.insert(schema.openappaExternalConsultsTable).values({
    id,
    organizationId: params.org,
    sessionId: params.session,
    createdAt,
    startedAt: createdAt,
    durationMs: 1,
    role: "authority",
    externalName: "reviewer",
    backend: params.backend,
    request: params.request,
    outcome: "answered",
    answer: params.answer,
    root: "root",
    trajectory: "root",
    offerId: params.offerId,
  });
  return id;
}

async function yellId(organizationId: string, sessionId: string) {
  const page = await OpenAppaYellModel.list({
    organizationId,
    sessionId,
    status: "all",
    limit: 10,
  });
  const [yell] = page.data;
  if (!yell) throw new Error(`no yell in ${sessionId}`);
  return yell.id;
}
