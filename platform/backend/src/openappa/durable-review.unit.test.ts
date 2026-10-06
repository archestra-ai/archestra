import { expect, test } from "vitest";
import {
  type DurableReviewPause,
  durableReviewActive,
  durableReviewPauses,
  noteDurableReview,
  runWithDurableReview,
  runWithoutDurableReview,
} from "./durable-review";

function pause(offerId: string): DurableReviewPause {
  return {
    offerId,
    jws: { protected: "header", payload: "payload", signature: "signature" },
    remedyArguments: { offer_id: offerId, plan: "review" },
    session: { organization_id: "org", session_id: offerId },
  };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a completed run does not disable another run's review sink", async () => {
  const firstStarted = signal();
  const continueFirst = signal();
  const first = runWithDurableReview(async () => {
    noteDurableReview(pause("first"));
    firstStarted.resolve();
    await continueFirst.promise;
    expect(durableReviewActive()).toBe(true);
    noteDurableReview(pause("first-followup"));
    return "first-result";
  });
  await firstStarted.promise;
  const second = await runWithDurableReview(async () => {
    expect(durableReviewPauses()).toEqual([]);
    noteDurableReview(pause("second"));
    return "second-result";
  });
  continueFirst.resolve();
  expect(second.pauses.map((item) => item.offerId)).toEqual(["second"]);
  expect((await first).pauses.map((item) => item.offerId)).toEqual([
    "first",
    "first-followup",
  ]);
  expect(durableReviewActive()).toBe(false);
});

test("a nested failure restores the parent sink without exposing child reviews", async () => {
  const parent = await runWithDurableReview(async () => {
    noteDurableReview(pause("parent"));
    await expect(
      runWithDurableReview(async () => {
        expect(durableReviewPauses()).toEqual([]);
        noteDurableReview(pause("child"));
        throw new Error("Child failed");
      }),
    ).rejects.toThrow("Child failed");
    expect(durableReviewActive()).toBe(true);
    noteDurableReview(pause("parent-followup"));
  });
  expect(parent.pauses.map((item) => item.offerId)).toEqual([
    "parent",
    "parent-followup",
  ]);
  expect(durableReviewActive()).toBe(false);
});

test("a headless child cannot park a review in its parent's sink", async () => {
  const parent = await runWithDurableReview(async () => {
    noteDurableReview(pause("parent"));
    await runWithoutDurableReview(async () => {
      expect(durableReviewActive()).toBe(false);
      expect(durableReviewPauses()).toEqual([]);
      noteDurableReview(pause("child"));
      await Promise.resolve();
      expect(durableReviewActive()).toBe(false);
    });
    expect(durableReviewActive()).toBe(true);
    expect(durableReviewPauses().map((item) => item.offerId)).toEqual([
      "parent",
    ]);
  });
  expect(parent.pauses.map((item) => item.offerId)).toEqual(["parent"]);
});
