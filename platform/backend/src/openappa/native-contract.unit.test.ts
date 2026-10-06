import { describe, expect, test } from "vitest";
import {
  contentDigest,
  type NativeRoomFacts,
  nativeRoomId,
  normalizeEmails,
  sameFacts,
} from "./native-contract";

const facts = (
  emails: string[] | null,
  trust: "trusted" | "suspicious" = "suspicious",
): NativeRoomFacts => ({
  ref: {
    provider: "slack",
    workspaceId: "T1",
    channelId: "C1",
    threadId: "thread",
  },
  trust,
  readers:
    emails === null ? { status: "unresolved" } : { status: "resolved", emails },
});

describe("native room snapshots", () => {
  test("a membership change is a new snapshot, not a rewrite of the old one", () => {
    const original = nativeRoomId({
      organizationId: "org",
      facts: facts(["Bob@example.com", "alice@example.com"]),
    });
    const wider = nativeRoomId({
      organizationId: "org",
      facts: facts(["alice@example.com", "bob@example.com", "eve@example.com"]),
    });
    const same = nativeRoomId({
      organizationId: "org",
      facts: facts([" alice@example.com ", "bob@example.com"]),
    });
    expect(wider).not.toBe(original);
    expect(same).toBe(original);
    expect(
      normalizeEmails([" Bob@example.com ", "alice@example.com", ""]),
    ).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("an unresolved roster is not an empty reader list", () => {
    const unknown = facts(null);
    const nobody = facts([]);
    expect(unknown.readers).toEqual({ status: "unresolved" });
    expect(nativeRoomId({ organizationId: "org", facts: unknown })).not.toBe(
      nativeRoomId({ organizationId: "org", facts: nobody }),
    );
    expect(sameFacts(unknown, nobody)).toBe(false);
  });

  test("the same ref in another organization does not share a snapshot", () => {
    const left = nativeRoomId({
      organizationId: "org-a",
      facts: facts(["a@example.com"]),
    });
    const right = nativeRoomId({
      organizationId: "org-b",
      facts: facts(["a@example.com"]),
    });
    expect(left).not.toBe(right);
  });

  test("field separators cannot make two room references share a snapshot", () => {
    const original = facts(["a@example.com"]);
    const first = {
      ...original,
      ref: { ...original.ref, channelId: "C\nD", threadId: "E" },
    };
    const second = {
      ...original,
      ref: { ...original.ref, channelId: "C", threadId: "D\nE" },
    };
    expect(nativeRoomId({ organizationId: "org", facts: first })).not.toBe(
      nativeRoomId({ organizationId: "org", facts: second }),
    );
  });

  test("content digest binds bytes and is not derived from trust", () => {
    expect(contentDigest("hello")).toBe(contentDigest("hello"));
    expect(contentDigest("hello")).not.toBe(contentDigest("hello "));
    expect(contentDigest("hello")).toHaveLength(64);
  });
});
