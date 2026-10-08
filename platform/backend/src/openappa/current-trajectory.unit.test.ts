import { describe, expect, test } from "vitest";
import { sessionCallerId } from "./actor";
import {
  currentTrajectory,
  parseCurrentTrajectory,
} from "./current-trajectory";

describe("current trajectory transport", () => {
  test("keeps a child bound to its actual parent after serialization", () => {
    const route = currentTrajectory({
      session_id: "user:test-user|root:child",
      parent_id: "user:test-user|root",
    });

    expect(parseCurrentTrajectory(JSON.parse(JSON.stringify(route)))).toEqual({
      v: 1,
      session_id: "user:test-user|root:child",
      parent_id: "user:test-user|root",
    });
  });

  test.each([
    undefined,
    null,
    [],
    { session_id: "user:test-user|root" },
    { v: 2, session_id: "user:test-user|root" },
    { v: 1, session_id: "" },
    { v: 1, session_id: 1 },
    { v: 1, session_id: "user:test-user|root", parent_id: "" },
    { v: 1, session_id: "user:test-user|root", parent_id: null },
    {
      v: 1,
      session_id: "user:test-user|root",
      caller_id: "user:different-user",
    },
  ])("rejects missing or malformed execution identity: %j", (value) => {
    expect(parseCurrentTrajectory(value)).toBeUndefined();
  });

  test.each([
    "user:test-user",
    "app:test-app",
    "virtual-key:test-key",
  ])("preserves the existing review cache scope for %s", (caller) => {
    expect(sessionCallerId(`${caller}|client|branch:child`)).toBe(caller);
  });

  test.each([
    "local-session",
    "local|branch",
    "|local",
    "user:|local",
  ])("does not assign a caller to an unscoped session: %s", (session) => {
    expect(sessionCallerId(session)).toBeUndefined();
  });
});
