import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { cacheManager } from "@/cache-manager";

// The canonical Map-backed fake from src/__mocks__/cache-manager.ts stands in
// for the distributed cache (preserves CacheKey etc.); the store resets before
// every test. A spy over the fake's real set() lets tests assert the TTLs.
vi.mock("@/cache-manager");

// isChannelAnswerAllEnabled reads the binding through the model; stub it so the
// cache behavior can be asserted without a database.
vi.mock("@/models/chatops-channel-binding", () => ({
  default: { findByChannel: vi.fn() },
}));

// applyChannelGate resolves the app name to match "<app name> mute" commands.
vi.mock("@/models/organization", () => ({
  default: { getAppName: vi.fn(async () => "Archestra") },
}));

const setSpy = vi.spyOn(cacheManager, "set");

import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import {
  applyChannelGate,
  claimThreadMuteHint,
  clearChannelThreadActive,
  clearChannelThreadMuted,
  findWorkspacesWithUnmentionedTraffic,
  getThreadMuteMarker,
  invalidateChannelAnswerAll,
  isChannelAnswerAllEnabled,
  isChannelThreadActive,
  isChannelThreadMuted,
  isMuteReaction,
  isThreadMuteCommand,
  markChannelThreadActive,
  markChannelThreadMuted,
  mightBeAddressedMuteCommand,
  muteChannelThread,
  recordUnmentionedChannelTraffic,
  resolveChannelGateAction,
} from "./channel-activation";
import { chatOpsRunRegistry } from "./chatops-run-registry";
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

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = setSpy.mock.calls[0];
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

describe("muteChannelThread (mute side-effects)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns the active→muted transition, like clearChannelThreadActive", async () => {
    await markChannelThreadActive(TEAMS);
    expect(await muteChannelThread(TEAMS)).toBe(true);
    expect(await isChannelThreadActive(TEAMS)).toBe(false);
    // A repeat mute (redelivered event) is a no-op transition.
    expect(await muteChannelThread(TEAMS)).toBe(false);
  });

  test("records a mute marker so in-flight runs can detect the mute", async () => {
    expect(await getThreadMuteMarker(TEAMS)).toBeNull();

    await muteChannelThread(TEAMS);

    expect(await getThreadMuteMarker(TEAMS)).not.toBeNull();
  });

  test("rewrites the marker with a fresh token on every mute", async () => {
    await muteChannelThread(TEAMS);
    const first = await getThreadMuteMarker(TEAMS);

    await muteChannelThread(TEAMS);
    const second = await getThreadMuteMarker(TEAMS);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // A different token each time is what lets a run tell "muted since I
    // started" apart from a stale marker left by an earlier mute.
    expect(second).not.toBe(first);
  });

  test("aborts in-flight runs registered for the thread", async () => {
    const run = chatOpsRunRegistry.register(TEAMS);
    expect(run.signal.aborted).toBe(false);

    await muteChannelThread(TEAMS);

    expect(run.signal.aborted).toBe(true);
    run.unregister();
  });

  test("the marker is scoped per (provider, channel, thread)", async () => {
    await muteChannelThread(TEAMS);

    // Same channel, different thread — its own marker is still unset.
    expect(
      await getThreadMuteMarker({ ...TEAMS, threadId: "other-thread" }),
    ).toBeNull();
    // Different provider, same ids — isolated too.
    expect(
      await getThreadMuteMarker({ ...TEAMS, provider: "slack" }),
    ).toBeNull();
  });

  test("persists the answer-all mute marker, so a mute survives in a channel with no activation to clear", async () => {
    expect(await isChannelThreadMuted(TEAMS)).toBe(false);

    // No prior activation — the case an answer-all channel is always in.
    expect(await muteChannelThread(TEAMS)).toBe(false);

    // Without this the thread would resume replying on the very next message.
    expect(await isChannelThreadMuted(TEAMS)).toBe(true);
  });

  test("a re-mention lifts the mute", async () => {
    await muteChannelThread(TEAMS);

    await clearChannelThreadMuted(TEAMS);

    expect(await isChannelThreadMuted(TEAMS)).toBe(false);
  });
});

describe("claimThreadMuteHint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns true the first time and false thereafter (one hint per thread)", async () => {
    expect(await claimThreadMuteHint(TEAMS)).toBe(true);
    expect(await claimThreadMuteHint(TEAMS)).toBe(false);
    expect(await claimThreadMuteHint(TEAMS)).toBe(false);
  });

  test("records the claim with the sticky auto-reply TTL", async () => {
    await claimThreadMuteHint(TEAMS);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = setSpy.mock.calls[0];
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

  describe('with a per-channel "answer all messages" setting', () => {
    test("an un-mentioned, inactive message is processed instead of ignored", () => {
      expect(
        resolveChannelGateAction({
          botMentioned: false,
          wantsMute: false,
          isActive: false,
          answerAll: true,
        }),
      ).toBe("process");
    });

    test("a muted thread stays quiet even though the channel answers all", () => {
      expect(
        resolveChannelGateAction({
          botMentioned: false,
          wantsMute: false,
          isActive: false,
          answerAll: true,
          isMuted: true,
        }),
      ).toBe("ignore");
    });

    test("a bare mute command is honored in an answer-all channel", () => {
      expect(
        resolveChannelGateAction({
          botMentioned: false,
          wantsMute: true,
          isActive: false,
          answerAll: true,
        }),
      ).toBe("mute");
    });

    test("a mention still activates, regardless of the answer-all flag", () => {
      expect(
        resolveChannelGateAction({
          botMentioned: true,
          wantsMute: false,
          isActive: false,
          answerAll: true,
        }),
      ).toBe("activate");
    });
  });
});

describe("answer-all per-thread mute markers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("a thread is unmuted until marked, then muted, then cleared", async () => {
    expect(await isChannelThreadMuted(TEAMS)).toBe(false);

    await markChannelThreadMuted(TEAMS);
    expect(await isChannelThreadMuted(TEAMS)).toBe(true);

    await clearChannelThreadMuted(TEAMS);
    expect(await isChannelThreadMuted(TEAMS)).toBe(false);
  });

  test("the mute marker is scoped per provider, channel, and thread", async () => {
    await markChannelThreadMuted(TEAMS);

    expect(await isChannelThreadMuted({ ...TEAMS, provider: "slack" })).toBe(
      false,
    );
    expect(
      await isChannelThreadMuted({ ...TEAMS, threadId: "other-thread" }),
    ).toBe(false);
  });

  test("the mute marker uses the sticky auto-reply TTL", async () => {
    await markChannelThreadMuted(TEAMS);
    expect(setSpy).toHaveBeenCalledWith(
      expect.stringContaining(CHANNEL),
      true,
      CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS,
    );
  });
});

describe("isChannelAnswerAllEnabled", () => {
  const CHANNEL_PARAMS = {
    provider: "slack",
    channelId: "C123",
    workspaceId: "T123",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("reflects the binding flag and caches it (one DB read per window)", async () => {
    vi.mocked(ChatOpsChannelBindingModel.findByChannel).mockResolvedValue({
      answerAllMessages: true,
    } as never);

    expect(await isChannelAnswerAllEnabled(CHANNEL_PARAMS)).toBe(true);
    // Second call is served from cache — no extra DB read.
    expect(await isChannelAnswerAllEnabled(CHANNEL_PARAMS)).toBe(true);
    expect(ChatOpsChannelBindingModel.findByChannel).toHaveBeenCalledTimes(1);
  });

  test("defaults to false when no binding exists", async () => {
    vi.mocked(ChatOpsChannelBindingModel.findByChannel).mockResolvedValue(null);
    expect(await isChannelAnswerAllEnabled(CHANNEL_PARAMS)).toBe(false);
  });

  test("invalidation forces a fresh read so a toggle takes effect", async () => {
    vi.mocked(ChatOpsChannelBindingModel.findByChannel).mockResolvedValue({
      answerAllMessages: false,
    } as never);
    expect(await isChannelAnswerAllEnabled(CHANNEL_PARAMS)).toBe(false);

    await invalidateChannelAnswerAll(CHANNEL_PARAMS);
    vi.mocked(ChatOpsChannelBindingModel.findByChannel).mockResolvedValue({
      answerAllMessages: true,
    } as never);
    expect(await isChannelAnswerAllEnabled(CHANNEL_PARAMS)).toBe(true);
    expect(ChatOpsChannelBindingModel.findByChannel).toHaveBeenCalledTimes(2);
  });
});

describe("un-mentioned channel traffic markers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The per-pod write throttle is module-level and outlives clearAllMocks, so
  // each test needs its own workspace id or a sibling's throttle entry would
  // suppress its write and leave the (per-test) fake cache store empty.
  test("only reports workspaces that actually delivered an un-mentioned message", async () => {
    await recordUnmentionedChannelTraffic({
      provider: "ms-teams",
      workspaceId: "team-reported",
    });

    expect(
      await findWorkspacesWithUnmentionedTraffic({
        provider: "ms-teams",
        workspaceIds: ["team-reported", "team-silent"],
      }),
    ).toEqual(["team-reported"]);
  });

  test("is scoped per provider", async () => {
    await recordUnmentionedChannelTraffic({
      provider: "ms-teams",
      workspaceId: "team-scoped",
    });

    expect(
      await findWorkspacesWithUnmentionedTraffic({
        provider: "slack",
        workspaceIds: ["team-scoped"],
      }),
    ).toEqual([]);
  });

  test("reports nothing when asked about no workspaces", async () => {
    expect(
      await findWorkspacesWithUnmentionedTraffic({
        provider: "ms-teams",
        workspaceIds: [],
      }),
    ).toEqual([]);
  });

  test("writes once per workspace instead of once per message", async () => {
    // The per-pod dedupe is module-level and outlives clearAllMocks, so this
    // workspace id must not be reused by another test.
    const params = {
      provider: "ms-teams",
      workspaceId: "team-write-once",
    } as const;

    await recordUnmentionedChannelTraffic(params);
    await recordUnmentionedChannelTraffic(params);
    await recordUnmentionedChannelTraffic(params);

    // Every un-mentioned channel message calls this; without the dedupe each one
    // would upsert the same Postgres-backed row.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(
      await findWorkspacesWithUnmentionedTraffic({
        provider: "ms-teams",
        workspaceIds: ["team-write-once"],
      }),
    ).toEqual(["team-write-once"]);
  });

  test("a failed write is retried by the next message, not throttled away", async () => {
    const params = {
      provider: "ms-teams",
      workspaceId: "team-write-fails",
    } as const;
    setSpy.mockRejectedValueOnce(new Error("cache unavailable"));

    await expect(recordUnmentionedChannelTraffic(params)).rejects.toThrow();

    // Throttling on a failed write would hide the workspace for the whole
    // window; the next message has to be able to record it.
    await recordUnmentionedChannelTraffic(params);
    expect(
      await findWorkspacesWithUnmentionedTraffic({
        provider: "ms-teams",
        workspaceIds: ["team-write-fails"],
      }),
    ).toEqual(["team-write-fails"]);
  });
});

describe.each([
  "slack",
  "ms-teams",
] as const)("applyChannelGate (%s)", (provider) => {
  const activation = { ...TEAMS, provider };
  let postMutedNotice: Mock<() => Promise<void>>;
  let resolveAnswerAllWorkspaceId: Mock<() => Promise<string | null>>;

  const gate = (overrides: Record<string, unknown> = {}) =>
    applyChannelGate({
      ...activation,
      botMentioned: false,
      text: "how do I deploy this?",
      postMutedNotice,
      resolveAnswerAllWorkspaceId,
      ...overrides,
    });

  const enableAnswerAll = (enabled: boolean) =>
    vi
      .mocked(ChatOpsChannelBindingModel.findByChannel)
      .mockResolvedValue(
        enabled ? ({ answerAllMessages: true } as never) : null,
      );

  beforeEach(() => {
    vi.clearAllMocks();
    postMutedNotice = vi.fn(async () => {});
    resolveAnswerAllWorkspaceId = vi.fn(async () => "T123");
    enableAnswerAll(false);
  });

  test("a mention activates the thread and is treated as addressed", async () => {
    expect(await gate({ botMentioned: true })).toEqual({
      proceed: true,
      addressed: true,
    });
    expect(await isChannelThreadActive(activation)).toBe(true);
  });

  test("an un-mentioned message in an inactive mentions-only channel is ignored", async () => {
    expect(await gate()).toEqual({ proceed: false, addressed: false });
  });

  test("an un-mentioned message in an active thread is processed as addressed", async () => {
    await markChannelThreadActive(activation);

    expect(await gate()).toEqual({ proceed: true, addressed: true });
  });

  test("an un-mentioned message in an answer-all channel is processed but NOT addressed", async () => {
    enableAnswerAll(true);

    // `addressed: false` is what keeps the bot from announcing itself to
    // someone who never spoke to it (see the Teams webhook route).
    expect(await gate()).toEqual({ proceed: true, addressed: false });
  });

  test("an answer-all thread that was muted stays ignored until re-mentioned", async () => {
    enableAnswerAll(true);
    await markChannelThreadMuted(activation);

    expect(await gate()).toEqual({ proceed: false, addressed: false });

    // A fresh mention lifts the mute, and the next un-mentioned message flows.
    expect(await gate({ botMentioned: true })).toEqual({
      proceed: true,
      addressed: true,
    });
    expect(await isChannelThreadMuted(activation)).toBe(false);
  });

  test("a mute command silences the thread and confirms exactly once", async () => {
    enableAnswerAll(true);

    expect(await gate({ text: "mute" })).toEqual({
      proceed: false,
      addressed: false,
    });
    expect(postMutedNotice).toHaveBeenCalledTimes(1);
    expect(await isChannelThreadMuted(activation)).toBe(true);

    // A redelivered / repeated mute must not spam the thread.
    await gate({ text: "mute" });
    expect(postMutedNotice).toHaveBeenCalledTimes(1);
  });

  test("a mute command in an inactive mentions-only channel stays silent", async () => {
    // The bot was not talking, so there is nothing to confirm.
    expect(await gate({ text: "mute" })).toEqual({
      proceed: false,
      addressed: false,
    });
    expect(postMutedNotice).not.toHaveBeenCalled();
  });

  test("a mute addressed by app name rather than @mention is honored", async () => {
    await markChannelThreadActive(activation);

    expect(await gate({ text: "Archestra shut up" })).toEqual({
      proceed: false,
      addressed: false,
    });
    expect(postMutedNotice).toHaveBeenCalledTimes(1);
  });

  test("still mutes when the answer-all setting cannot be read", async () => {
    resolveAnswerAllWorkspaceId.mockRejectedValue(
      new Error("TeamsInfo unavailable"),
    );
    await markChannelThreadActive(activation);
    const run = chatOpsRunRegistry.register(activation);

    expect(await gate({ text: "mute" })).toEqual({
      proceed: false,
      addressed: false,
    });

    // Silencing the bot must survive a failed lookup — otherwise an in-flight
    // reply lands after the user asked for quiet.
    expect(run.signal.aborted).toBe(true);
    expect(await isChannelThreadActive(activation)).toBe(false);
    run.unregister();
  });

  test("falls back to mentions-only when the answer-all setting cannot be read", async () => {
    vi.mocked(ChatOpsChannelBindingModel.findByChannel).mockRejectedValue(
      new Error("database unavailable"),
    );

    // Quiet is the safe default: a failed read must not make the bot answer
    // messages it would otherwise ignore.
    expect(await gate()).toEqual({ proceed: false, addressed: false });
  });

  test("does not resolve the answer-all workspace id when the outcome cannot change", async () => {
    // Mentioned: resolves to "activate" regardless of the setting.
    await gate({ botMentioned: true });
    expect(resolveAnswerAllWorkspaceId).not.toHaveBeenCalled();

    // Already active: resolves to "process" regardless of the setting.
    await gate();
    expect(resolveAnswerAllWorkspaceId).not.toHaveBeenCalled();

    // Un-mentioned and inactive is the only case the setting decides — and
    // for Teams resolving it costs a Bot Framework round trip.
    await clearChannelThreadActive(activation);
    await gate();
    expect(resolveAnswerAllWorkspaceId).toHaveBeenCalledTimes(1);
  });
});
