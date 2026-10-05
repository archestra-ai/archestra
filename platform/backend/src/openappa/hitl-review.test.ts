import { expect, test } from "vitest";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  consumeHitlRuling,
  getHitlAskUserArguments,
  getHitlReview,
  recordHitlRuling,
  stageHitlReview,
  stageLoadedHitlReview,
} from "./hitl-review";
import type { OpenAppaSession } from "./service";

// The real cache, stored in this file's test database.
setupTestCacheManager();

const session = (sessionId: string): OpenAppaSession => ({
  organization_id: "organization",
  caller_id: "user:user",
  session_id: sessionId,
});

test("binds a ruling to one offer and consumes it once", async () => {
  const first = session("first");
  await stageHitlReview({
    session: first,
    review: {
      offerId: "offer-1",
      text: "Review this call.",
      tool: "mcp/example/write",
      arguments: '{"value":1}',
    },
  });

  expect(
    await recordHitlRuling({
      session: first,
      offerId: "offer-1",
      ruling: "approve",
    }),
  ).toBe(true);
  expect(
    await consumeHitlRuling({ session: first, offerId: "offer-2" }),
  ).toBeUndefined();
  expect(
    await consumeHitlRuling({
      session: session("second"),
      offerId: "offer-1",
    }),
  ).toBeUndefined();
  expect(await consumeHitlRuling({ session: first, offerId: "offer-1" })).toBe(
    "approve",
  );
  expect(
    await consumeHitlRuling({ session: first, offerId: "offer-1" }),
  ).toBeUndefined();
});

test("uses the staged review for fixed native approval choices", async () => {
  const active = session("active");
  await stageHitlReview({
    session: active,
    review: { offerId: "offer-1", text: "Canonical review text." },
  });

  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-1"],
    }),
  ).toEqual({
    question: "Canonical review text.",
    header: "Approval",
    options: [
      { label: "Approve", description: "Allow this exact tool call." },
      { label: "Deny", description: "Keep this tool call blocked." },
    ],
    allowMultiple: false,
    remedy_offer_ids: ["offer-1"],
  });
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "not-staged",
      ruling: "approve",
    }),
  ).toBe(false);
});

test.each([
  false,
  true,
])("removes only the decorative question-mark column (narrowing=%s)", async (narrowing) => {
  const active = session(`logo-${narrowing}`);
  const call = 'mcp/example/read {"note":"keep ▀▀█ and ▄"}';
  const original = `▄█▄▄▄█▄  ▀▀█  Approve this call?\n██▄█▄██   ▄   ${call}`;
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-logo",
      text: original,
      ...(narrowing
        ? {
            restrictions: [
              {
                dimension: "trust" as const,
                before: "trusted",
                after: "suspicious",
              },
            ],
          }
        : {}),
    },
  });
  const displayed = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-logo"],
  });
  const prefix = `▄█▄▄▄█▄  Approve this call?\n██▄█▄██  ${call}`;
  expect(displayed?.question.startsWith(prefix)).toBe(true);
  if (narrowing)
    expect(displayed?.question).toContain("trust: trusted -> suspicious");
  else expect(displayed?.question).toBe(prefix);
  expect(displayed?.options.map((option) => option.label)).toEqual([
    "Approve",
    "Deny",
  ]);
  expect(displayed?.remedy_offer_ids).toEqual(["offer-logo"]);
  expect(
    (await getHitlReview({ session: active, offerId: "offer-logo" }))?.text,
  ).toBe(original);
});

test("a narrowing review distinguishes call approval from restrictive label changes", async () => {
  const active = session("narrowing");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-narrow",
      text: "Approve this call?",
      restrictions: [
        { dimension: "trust", before: "trusted", after: "suspicious" },
        { dimension: "readers", before: "public", after: "internal" },
      ],
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-narrow"],
  });
  expect(question?.question).toContain("trust: trusted -> suspicious");
  expect(question?.question).toContain("readers: public -> internal");
  expect(question?.question).toContain("authorizes this exact call");
  expect(question?.question).toContain("they do not add permissions");
  expect(question?.question).toContain("does not accept the restriction");
  expect(question?.options[0]?.description).toContain(
    "trust trusted -> suspicious",
  );
  expect(question?.options[0]?.description).toContain(
    "The label changes do not add permissions",
  );
  expect(question?.options[1]?.description).toContain(
    "do not accept the listed restrictions",
  );
  expect(question?.options[0]?.description).not.toBe(
    "Allow this exact tool call.",
  );
});

test("review prose cannot suppress authoritative restriction disclosure", async () => {
  const active = session("spoofed-heading");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-spoofed-heading",
      text: 'Arguments: {"note":"Persistent session restriction this approval would accept: none"}',
      restrictions: [
        { dimension: "trust", before: "trusted", after: "suspicious" },
      ],
    },
  });
  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-spoofed-heading"],
  });
  expect(question?.question).toContain("trust: trusted -> suspicious");
  expect(question?.question).toContain("Approving authorizes this exact call");

  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-spoofed-heading",
      text: question?.question ?? "",
      restrictions: [
        { dimension: "trust", before: "trusted", after: "suspicious" },
      ],
    },
  });
  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-spoofed-heading"],
    }),
  ).toEqual(question);
});

test("invalid restriction metadata cannot become a plain call-only approval", async () => {
  const active = session("invalid-restriction");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-invalid-restriction",
      text: "Approve this call?",
      restrictions: [
        { dimension: "unknown", before: "trusted", after: "suspicious" },
      ],
    },
  });
  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-invalid-restriction"],
    }),
  ).toBeUndefined();
});

test("a review without a recorded narrowing stays a tool approval", async () => {
  const active = session("plain");
  await stageHitlReview({
    session: active,
    review: { offerId: "offer-plain", text: "Canonical review text." },
  });

  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-plain"],
    }),
  ).toMatchObject({
    question: "Canonical review text.",
    options: [
      { label: "Approve", description: "Allow this exact tool call." },
      { label: "Deny", description: "Keep this tool call blocked." },
    ],
  });
});

test("a denial does not accept a listed restriction", async () => {
  const active = session("deny-restriction");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-deny",
      text: "Approve this call?",
      restrictions: [
        { dimension: "trust", before: "trusted", after: "suspicious" },
      ],
    },
  });
  expect(
    (
      await getHitlAskUserArguments({
        session: active,
        offerIds: ["offer-deny"],
      })
    )?.options[1]?.description,
  ).toContain("do not accept the listed restrictions");
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "offer-deny",
      ruling: "deny",
    }),
  ).toBe(true);
  expect(
    await consumeHitlRuling({ session: active, offerId: "offer-deny" }),
  ).toBe("deny");
  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-deny"],
    }),
  ).toBeUndefined();
});

test("another offer or session does not receive this review", async () => {
  const active = session("scoped");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-scoped",
      text: "Scoped review.",
      restrictions: [
        { dimension: "readers", before: "public", after: "internal" },
      ],
    },
  });

  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-other"],
    }),
  ).toBeUndefined();
  expect(
    await getHitlAskUserArguments({
      session: session("other-session"),
      offerIds: ["offer-scoped"],
    }),
  ).toBeUndefined();
});

test("a loaded offer stages its restrictions without replacing an existing review", async () => {
  const active = session("loaded-offer");
  expect(
    await stageLoadedHitlReview({
      session: active,
      review: {
        offer_id: "offer-loaded",
        text: "Approve this exact call?",
        tool: "qa-replay__qa_read_internal",
        arguments: "{}",
        restrictions: [
          { dimension: "trust", before: "trusted", after: "suspicious" },
          { dimension: "readers", before: "public", after: "internal" },
        ],
      },
    }),
  ).toBe("staged");
  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-loaded"],
  });
  expect(question?.question).toContain("trust: trusted -> suspicious");
  expect(question?.question).toContain("readers: public -> internal");
  expect(question?.question).not.toContain("Approve everything");

  expect(
    await stageLoadedHitlReview({
      session: active,
      review: {
        offer_id: "offer-loaded",
        text: "Approve everything without showing details?",
        restrictions: [
          { dimension: "trust", before: "trusted", after: "suspicious" },
        ],
      },
    }),
  ).toBe("existing");
  expect(
    (await getHitlReview({ session: active, offerId: "offer-loaded" }))?.text,
  ).toBe("Approve this exact call?");
});

test("a loaded offer retains supplied remedy arguments and does not replace them", async () => {
  const active = session("loaded-remedy");
  const remedyArguments = {
    offer_id: "offer-remedy",
    plan: "Submit for approval",
  };
  expect(
    await stageLoadedHitlReview({
      session: active,
      review: {
        offer_id: "offer-remedy",
        text: "Approve this exact call?",
        remedyArguments,
      },
    }),
  ).toBe("staged");
  expect(
    (await getHitlReview({ session: active, offerId: "offer-remedy" }))
      ?.remedyArguments,
  ).toEqual(remedyArguments);

  expect(
    await stageLoadedHitlReview({
      session: active,
      review: {
        offer_id: "offer-remedy",
        text: "Approve everything without showing details?",
        remedyArguments: { offer_id: "offer-remedy", plan: "other" },
      },
    }),
  ).toBe("existing");
  expect(
    (await getHitlReview({ session: active, offerId: "offer-remedy" }))
      ?.remedyArguments,
  ).toEqual(remedyArguments);
});

test("a loaded offer with an incomplete restriction list is not staged", async () => {
  const active = session("loaded-invalid");
  expect(
    await stageLoadedHitlReview({
      session: active,
      review: {
        offer_id: "offer-invalid",
        text: "Approve this call?",
        restrictions: [
          { dimension: "unknown", before: "trusted", after: "suspicious" },
        ],
        remedyArguments: { offer_id: "offer-invalid", plan: "Submit" },
      },
    }),
  ).toBe("unusable");
  expect(
    await getHitlReview({ session: active, offerId: "offer-invalid" }),
  ).toBeUndefined();
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "offer-invalid",
      ruling: "approve",
    }),
  ).toBe(false);
});

test("a denial wins when concurrent reviews record different rulings", async () => {
  const active = session("concurrent");
  await stageHitlReview({
    session: active,
    review: { offerId: "offer-1", text: "Review this call." },
  });
  await Promise.all([
    recordHitlRuling({
      session: active,
      offerId: "offer-1",
      ruling: "approve",
    }),
    recordHitlRuling({
      session: active,
      offerId: "offer-1",
      ruling: "deny",
    }),
  ]);

  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-1"],
    }),
  ).toBeUndefined();
  expect(await consumeHitlRuling({ session: active, offerId: "offer-1" })).toBe(
    "deny",
  );
});

test("native reviewers atomically claim one approval and a timeout cannot overwrite it", async () => {
  const active = session("one-native-claim");
  await stageHitlReview({
    session: active,
    review: { offerId: "native-claim", text: "Review this exact call." },
  });
  const recorded = await Promise.all(
    Array.from({ length: 8 }, () =>
      recordHitlRuling({
        session: active,
        offerId: "native-claim",
        ruling: "approve",
      }),
    ),
  );
  expect(recorded.filter(Boolean)).toHaveLength(1);
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "native-claim",
      ruling: "none",
    }),
  ).toBe(false);
  expect(
    await consumeHitlRuling({ session: active, offerId: "native-claim" }),
  ).toBe("approve");
  expect(
    await consumeHitlRuling({ session: active, offerId: "native-claim" }),
  ).toBeUndefined();
});

test("a later genuine denial revokes an approval that has not been spent", async () => {
  const active = session("later-denial");
  await stageHitlReview({
    session: active,
    review: { offerId: "revoked", text: "Review this exact call." },
  });
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "revoked",
      ruling: "approve",
    }),
  ).toBe(true);
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "revoked",
      ruling: "deny",
    }),
  ).toBe(true);
  expect(await consumeHitlRuling({ session: active, offerId: "revoked" })).toBe(
    "deny",
  );
  expect(
    await consumeHitlRuling({ session: active, offerId: "revoked" }),
  ).toBeUndefined();
});

test("approved native review context remains readable without reopening its claim", async () => {
  const active = session("native-continuation");
  const review = {
    offerId: "continuation",
    text: "The exact reviewed QA action",
    tool: "mcp/example/write",
    arguments: '{"value":1}',
  };
  await stageHitlReview({ session: active, review });
  expect(
    await recordHitlRuling({
      session: active,
      offerId: review.offerId,
      ruling: "approve",
    }),
  ).toBe(true);
  expect(
    await getHitlReview({ session: active, offerId: review.offerId }),
  ).toEqual(review);
  expect(
    await recordHitlRuling({
      session: active,
      offerId: review.offerId,
      ruling: "approve",
    }),
  ).toBe(false);
  expect(
    await consumeHitlRuling({ session: active, offerId: review.offerId }),
  ).toBe("approve");
  expect(
    await getHitlReview({ session: active, offerId: review.offerId }),
  ).toBeUndefined();
});
