import { describe, expect, it } from "vitest";
import {
  offersDefaultPin,
  resolveDefaultAgentBadge,
} from "./default-agent-tag";

/**
 * One agent starts a member's new chats, so one row carries the badge. These
 * pin down which — the question a reader would otherwise have to answer by
 * comparing two badges against a precedence rule they cannot see.
 */
describe("resolveDefaultAgentBadge", () => {
  it("badges the member's pin, and only it, when they have one", () => {
    expect(
      resolveDefaultAgentBadge({
        personalDefaultAgentId: "mine",
        organizationDefaultAgentId: "org",
      }),
    ).toEqual({ agentId: "mine", source: "me" });
  });

  it("badges the organization default when the member has not pinned one", () => {
    expect(
      resolveDefaultAgentBadge({
        personalDefaultAgentId: null,
        organizationDefaultAgentId: "org",
      }),
    ).toEqual({ agentId: "org", source: "org" });
  });

  it("credits the organization when the member pinned the organization default", () => {
    // Pinning the agent the organization already defaults to does not make it
    // personally theirs: it starts their chats either way, so the row must not
    // invite them to unpin something that would go on applying regardless.
    expect(
      resolveDefaultAgentBadge({
        personalDefaultAgentId: "same",
        organizationDefaultAgentId: "same",
      }),
    ).toEqual({ agentId: "same", source: "org" });
  });

  it("credits the pin once the organization default moves elsewhere", () => {
    // The same stored pin, now the only reason that agent applies.
    expect(
      resolveDefaultAgentBadge({
        personalDefaultAgentId: "mine",
        organizationDefaultAgentId: "moved",
      }),
    ).toEqual({ agentId: "mine", source: "me" });
  });

  it("badges nothing when neither is configured", () => {
    // The seeded personal assistant still starts their chats, but nobody chose
    // it — calling it a default is what hid the organization setting.
    expect(
      resolveDefaultAgentBadge({
        personalDefaultAgentId: null,
        organizationDefaultAgentId: null,
      }),
    ).toBeNull();
  });
});

describe("offersDefaultPin", () => {
  it("does not offer the pin on the row standing in as the org default", () => {
    // That row already reads `default (org)`: pinning it would offer to make
    // true what the badge beside it says is already true.
    expect(
      offersDefaultPin({
        agentId: "org",
        badge: { agentId: "org", source: "org" },
      }),
    ).toBe(false);
  });

  it("offers unpinning on a pin of the viewer's own", () => {
    expect(
      offersDefaultPin({
        agentId: "mine",
        badge: { agentId: "mine", source: "me" },
      }),
    ).toBe(true);
  });

  it("stays hidden on a pinned org default, which reads as the org's", () => {
    // resolveDefaultAgentBadge reports "org" for that row, so the two rules
    // agree without either having to know how the pin was stored.
    const badge = resolveDefaultAgentBadge({
      personalDefaultAgentId: "same",
      organizationDefaultAgentId: "same",
    });
    expect(offersDefaultPin({ agentId: "same", badge })).toBe(false);
  });

  it("offers the pin on every other row, badged or not", () => {
    expect(
      offersDefaultPin({
        agentId: "other",
        badge: { agentId: "org", source: "org" },
      }),
    ).toBe(true);
    expect(offersDefaultPin({ agentId: "other", badge: null })).toBe(true);
  });
});
