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
    },
  };
});

import {
  isChannelThreadActive,
  markChannelThreadActive,
  resolveChannelGateAction,
} from "./channel-activation";
import { CHATOPS_CHANNEL_AUTO_REPLY } from "./constants";

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
});

describe("resolveChannelGateAction", () => {
  // Non-channel conversations (1:1 DMs, multi-person group chats) are never
  // gated — always "process", for both flag states.
  test.each([
    ["personal", true, true],
    ["personal", true, false],
    ["personal", false, true],
    ["personal", false, false],
    ["groupChat", true, true],
    ["groupChat", true, false],
    ["groupChat", false, true],
    ["groupChat", false, false],
  ] as const)("%s conversation with stickyEnabled=%s, wasMentioned=%s → process", (conversationType, stickyEnabled, wasMentioned) => {
    expect(
      resolveChannelGateAction({
        conversationType,
        stickyEnabled,
        wasMentioned,
      }),
    ).toBe("process");
  });

  test("channel, sticky disabled, mentioned → process (no activation)", () => {
    expect(
      resolveChannelGateAction({
        conversationType: "channel",
        stickyEnabled: false,
        wasMentioned: true,
      }),
    ).toBe("process");
  });

  test("channel, sticky disabled, not mentioned → skip", () => {
    expect(
      resolveChannelGateAction({
        conversationType: "channel",
        stickyEnabled: false,
        wasMentioned: false,
      }),
    ).toBe("skip");
  });

  test("channel, sticky enabled, mentioned → process-and-activate", () => {
    expect(
      resolveChannelGateAction({
        conversationType: "channel",
        stickyEnabled: true,
        wasMentioned: true,
      }),
    ).toBe("process-and-activate");
  });

  test("channel, sticky enabled, not mentioned → check-active", () => {
    expect(
      resolveChannelGateAction({
        conversationType: "channel",
        stickyEnabled: true,
        wasMentioned: false,
      }),
    ).toBe("check-active");
  });
});
