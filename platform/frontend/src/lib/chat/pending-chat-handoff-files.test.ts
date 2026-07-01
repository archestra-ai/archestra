import type { FileUIPart } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  drainPendingChatHandoffFiles,
  hasPendingChatHandoffFiles,
  setPendingChatHandoffFiles,
} from "./pending-chat-handoff-files";

const file = (name: string): FileUIPart => ({
  type: "file",
  url: `data:text/plain;base64,${btoa(name)}`,
  mediaType: "text/plain",
  filename: name,
});

describe("pending-chat-handoff-files", () => {
  // Module-level singleton: reset between tests so leakage shows up as a
  // failure rather than carrying across cases.
  beforeEach(() => {
    drainPendingChatHandoffFiles();
  });

  it("starts empty", () => {
    expect(hasPendingChatHandoffFiles()).toBe(false);
    expect(drainPendingChatHandoffFiles()).toEqual([]);
  });

  it("drains the stashed files exactly once", () => {
    const files = [file("a.txt"), file("b.txt")];
    setPendingChatHandoffFiles(files);

    expect(hasPendingChatHandoffFiles()).toBe(true);
    expect(drainPendingChatHandoffFiles()).toEqual(files);

    // Consumed: a second drain yields nothing, so a remount can't re-send.
    expect(hasPendingChatHandoffFiles()).toBe(false);
    expect(drainPendingChatHandoffFiles()).toEqual([]);
  });

  it("replaces the set wholesale so a later handoff can't inherit stale files", () => {
    setPendingChatHandoffFiles([file("old.txt")]);
    // A text-only handoff stashes an empty array, which must clear the prior set.
    setPendingChatHandoffFiles([]);

    expect(hasPendingChatHandoffFiles()).toBe(false);
    expect(drainPendingChatHandoffFiles()).toEqual([]);
  });

  it("a peek does not consume", () => {
    setPendingChatHandoffFiles([file("a.txt")]);

    expect(hasPendingChatHandoffFiles()).toBe(true);
    expect(hasPendingChatHandoffFiles()).toBe(true);
    expect(drainPendingChatHandoffFiles()).toHaveLength(1);
  });
});
