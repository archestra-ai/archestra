import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the distributed cache with an in-memory Map (preserve CacheKey etc.).
// The `mock`-prefixed names are referenced lazily inside the fn bodies so they
// survive vi.mock hoisting.
const mockCache = new Map<string, unknown>();
const mockSetCalls: Array<[string, unknown, number | undefined]> = [];
vi.mock("@/cache-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...actual,
    cacheManager: {
      get: vi.fn(async (key: string) => mockCache.get(key)),
      set: vi.fn(async (key: string, value: unknown, ttl?: number) => {
        mockCache.set(key, value);
        mockSetCalls.push([key, value, ttl]);
      }),
      delete: vi.fn(async (key: string) => mockCache.delete(key)),
    },
  };
});

import {
  claimThreadMuteHint,
  clearChannelThreadActive,
  isChannelThreadActive,
  isMuteReaction,
  isThreadMuteCommand,
  markChannelThreadActive,
  mightBeAddressedMuteCommand,
  resolveChannelGateAction,
} from "./channel-activation";
import {
  buildThreadMutedNotice,
  CHATOPS_CHANNEL_AUTO_REPLY,
} from "./constants";

const CHANNEL = "19:abc@thread.tacv2";
const THREAD = "1700000000000";
const TEAMS = {
  provider: "ms-teams",
  channelId: CHANNEL,
  threadId: THREAD,
} as const;

describe("channel-activation (sticky channel auto-reply)", () => {
  beforeEach(() => {
    mockCache.clear();
    mockSetCalls.length = 0;
    vi.clearAllMocks();
  });

  test("a thread is inactive until it is marked active", async () => {
    expect(await isChannelThreadActive(TEAMS)).toBe(false);

    await markChannelThreadActive(TEAMS);

    expect(await isChannelThreadActive(TEAMS)).toBe(true);
  });

  test("activation is scoped per (channel, thread)", async () => {
    await markChannelThreadActive(TEAMS);

    // Same channel, different thread → still inactive (mention must be per-thread).
    expect(
      await isChannelThreadActive({ ...TEAMS, threadId: "other-thread" }),
    ).toBe(false);
    // Different channel, same thread id → independent.
    expect(
      await isChannelThreadActive({
        ...TEAMS,
        channelId: "19:other@thread.tacv2",
      }),
    ).toBe(false);
  });

  test("activation is scoped per provider", async () => {
    await markChannelThreadActive(TEAMS);

    // Same channel/thread ids under a different provider → independent.
    expect(await isChannelThreadActive({ ...TEAMS, provider: "slack" })).toBe(
      false,
    );

    await markChannelThreadActive({ ...TEAMS, provider: "slack" });
    expect(await isChannelThreadActive({ ...TEAMS, provider: "slack" })).toBe(
      true,
    );
  });

  test("marking active writes with the configured TTL", async () => {
    await markChannelThreadActive(TEAMS);

    expect(mockSetCalls).toHaveLength(1);
    const [key, value, ttl] = mockSetCalls[0];
    expect(key).toContain(CHANNEL);
    expect(value).toBe(true);
    expect(ttl).toBe(CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS);
  });

  test("clearing deactivates a thread (mute), scoped per thread", async () => {
    await markChannelThreadActive(TEAMS);
    const other = { ...TEAMS, threadId: "other-thread" };
    await markChannelThreadActive(other);

    // Returns true: it actually transitioned this thread active → muted.
    expect(await clearChannelThreadActive(TEAMS)).toBe(true);

    expect(await isChannelThreadActive(TEAMS)).toBe(false);
    // A different thread in the same channel is untouched.
    expect(await isChannelThreadActive(other)).toBe(true);
  });

  test("clearing a never-active thread returns false (no transition)", async () => {
    expect(await clearChannelThreadActive(TEAMS)).toBe(false);
    expect(await isChannelThreadActive(TEAMS)).toBe(false);
  });

  test("clearing an already-muted thread returns false (idempotent)", async () => {
    await markChannelThreadActive(TEAMS);
    expect(await clearChannelThreadActive(TEAMS)).toBe(true);
    // Second clear (e.g. a redelivered event) is a no-op transition.
    expect(await clearChannelThreadActive(TEAMS)).toBe(false);
  });
});

describe("claimThreadMuteHint", () => {
  beforeEach(() => {
    mockCache.clear();
    mockSetCalls.length = 0;
    vi.clearAllMocks();
  });

  test("returns true the first time and false thereafter (one hint per thread)", async () => {
    expect(await claimThreadMuteHint(TEAMS)).toBe(true);
    expect(await claimThreadMuteHint(TEAMS)).toBe(false);
    expect(await claimThreadMuteHint(TEAMS)).toBe(false);
  });

  test("records the claim with the sticky auto-reply TTL", async () => {
    await claimThreadMuteHint(TEAMS);

    expect(mockSetCalls).toHaveLength(1);
    const [key, value, ttl] = mockSetCalls[0];
    expect(key).toContain(CHANNEL);
    expect(value).toBe(true);
    expect(ttl).toBe(CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS);
  });

  test("is scoped per (provider, channel, thread)", async () => {
    expect(await claimThreadMuteHint(TEAMS)).toBe(true);

    // Same channel/thread, other provider → independent claim.
    expect(await claimThreadMuteHint({ ...TEAMS, provider: "slack" })).toBe(
      true,
    );
    // Same channel, different thread → independent claim.
    expect(
      await claimThreadMuteHint({ ...TEAMS, threadId: "other-thread" }),
    ).toBe(true);
    // Different channel, same thread → independent claim.
    expect(
      await claimThreadMuteHint({
        ...TEAMS,
        channelId: "19:other@thread.tacv2",
      }),
    ).toBe(true);
  });

  test("its key does not collide with the activation key (mute ≠ hint)", async () => {
    await markChannelThreadActive(TEAMS);
    // The hint slot is still unclaimed even though the thread is active.
    expect(await claimThreadMuteHint(TEAMS)).toBe(true);
    // ...and claiming the hint does not deactivate the thread.
    expect(await isChannelThreadActive(TEAMS)).toBe(true);
  });
});

describe("isMuteReaction", () => {
  test.each([
    "mute", // 🔇 Slack
    "1f507_mutedspeaker", // 🔇 Teams
    "shushing_face", // 🤫 Slack
    "lipssealed", // 🤫 Teams
    "MUTE", // case-insensitive
    "  lipssealed  ", // surrounding whitespace
  ])("treats %j as a mute reaction", (id) => {
    expect(isMuteReaction(id)).toBe(true);
  });

  test.each([
    "",
    "like",
    "heart",
    "thumbsup",
    "tada",
    "1f44d_thumbsup",
    "muted", // not an emoji id
  ])("does not treat %j as a mute reaction", (id) => {
    expect(isMuteReaction(id)).toBe(false);
  });
});

describe("isThreadMuteCommand", () => {
  test.each([
    "mute",
    "Mute",
    "  mute  ",
    "mute.",
    "mute!",
    "/mute",
    "mute thread",
    "mute this thread",
    "stop replying",
    "stop responding",
    "stop auto-replying",
    "stand down",
    "be quiet",
    "stay quiet",
    "shut up",
    "Shut up!",
  ])("treats %j as a mute command", (text) => {
    expect(isThreadMuteCommand(text)).toBe(true);
  });

  test.each([
    "",
    "muted",
    "mute the alerts channel",
    "how do I mute notifications?",
    "stop the deployment",
    "can you stop replying to everyone but me",
    "please be quiet about the release date",
    "unmute",
    "mute mute",
    "shut up about the deploy",
  ])("does not treat %j as a mute command", (text) => {
    expect(isThreadMuteCommand(text)).toBe(false);
  });

  describe("with an addressable name prefix (no explicit @mention)", () => {
    const names = ["Archestra", "Acme Bot"];

    test.each([
      "Archestra shut up",
      "archestra mute",
      "Archestra, stand down",
      "Acme Bot shut up",
      "Acme Bot: be quiet",
    ])("treats %j as a mute command", (text) => {
      expect(isThreadMuteCommand(text, names)).toBe(true);
    });

    test.each([
      "joey shut up", // aimed at a person, not the bot
      "Archestra shut up the alerts channel", // not an exact command after the name
      "Archestra what's the status", // addressed, but not a mute
      "shut up Archestra", // name not a leading prefix
    ])("does not treat %j as a mute command", (text) => {
      expect(isThreadMuteCommand(text, names)).toBe(false);
    });

    test("a bare command still matches without any names passed", () => {
      expect(isThreadMuteCommand("shut up")).toBe(true);
    });
  });
});

describe("mightBeAddressedMuteCommand", () => {
  test.each([
    "Archestra shut up",
    "acme mute",
    "potato-claw stop replying",
  ])("flags %j as possibly an addressed mute (ends with a command)", (text) => {
    expect(mightBeAddressedMuteCommand(text)).toBe(true);
  });

  test.each([
    "shut up", // bare — handled without resolving a name
    "hello there",
    "let's mute the alerts channel",
    "",
  ])("does not flag %j", (text) => {
    expect(mightBeAddressedMuteCommand(text)).toBe(false);
  });
});

describe("buildThreadMutedNotice", () => {
  test("always confirms the mute and how to un-mute, with a varied lead-in", () => {
    const notices = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const notice = buildThreadMutedNotice();
      expect(notice.startsWith("🔇 ")).toBe(true);
      // The reassurance (how to bring the bot back) is always present.
      expect(notice).toContain("@mention me to bring me back.");
      notices.add(notice);
    }
    // The lead-in is randomized, so 50 draws should surface more than one.
    expect(notices.size).toBeGreaterThan(1);
  });
});

describe("resolveChannelGateAction", () => {
  test.each([
    // botMentioned, wantsMute, isActive -> action
    [true, true, false, "mute"], // mentioned + "mute" -> mute
    [true, true, true, "mute"], // mentioned + "mute" in active thread -> mute
    [true, false, false, "activate"], // fresh mention -> activate
    [true, false, true, "activate"], // mention re-affirms activation
    [false, true, true, "mute"], // bare "mute" in active thread -> mute
    [false, false, true, "process"], // un-mentioned reply in active thread -> reply
    [false, true, false, "ignore"], // "mute" but thread inactive + not addressed
    [false, false, false, "ignore"], // un-mentioned, inactive -> stay quiet
  ] as const)("botMentioned=%s wantsMute=%s isActive=%s -> %s", (botMentioned, wantsMute, isActive, expected) => {
    expect(
      resolveChannelGateAction({ botMentioned, wantsMute, isActive }),
    ).toBe(expected);
  });
});
