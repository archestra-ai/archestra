import type { archestraApiTypes } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useInteractionSessions,
  useUniqueUserIds,
} from "@/lib/interactions/interaction.query";
import LlmProxyLogsPage from "./page.client";

// The cmdk-backed picker reaches for pointer-capture / scrollIntoView /
// ResizeObserver, which jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/agent.query", () => ({ useProfiles: vi.fn() }));
vi.mock("@/lib/interactions/interaction.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/interactions/interaction.query")
  >()),
  useInteractionSessions: vi.fn(),
  useUniqueUserIds: vi.fn(),
}));

// Two users can each name their own agent "My Agent", so the filter has to
// carry enough context to tell them apart.
const personalProxy = {
  id: "p1",
  name: "My Proxy",
  agentType: "agent",
  scope: "personal",
  authorEmail: "owner@example.com",
};

const orgProxy = {
  id: "p2",
  name: "Shared Proxy",
  agentType: "agent",
  scope: "org",
};

const push = vi.fn();

type SessionSummary =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];

function makeSessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: "demo-session",
    sessionSource: null,
    source: "api",
    sources: ["api"],
    interactionId: null,
    requestCount: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: "0.01",
    totalBilledCost: "0.01",
    totalSubscriptionCost: null,
    totalBaselineCost: "0.01",
    totalToonCostSavings: null,
    totalCacheSavings: null,
    toonSkipReasonCounts: {
      applied: 0,
      notEnabled: 0,
      notEffective: 0,
      noToolResults: 0,
    },
    firstRequestTime: "2026-08-23T16:20:00.000Z",
    lastRequestTime: "2026-08-23T16:30:00.000Z",
    models: ["gpt-5.4"],
    profileId: orgProxy.id,
    profileName: orgProxy.name,
    externalAgentIds: [],
    externalAgentIdLabels: [],
    authMethods: [],
    authenticatedAppNames: [],
    userNames: [],
    userIds: [],
    unattributedReason: null,
    virtualKeys: [],
    lastUserMessagePreview: null,
    lastInteractionType: null,
    conversationTitle: null,
    claudeCodeTitle: null,
    ...overrides,
  };
}

// role="combobox" takes no accessible name from its contents, so the trigger is
// addressed by the label it renders.
async function openProxyFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("All Agents"));
}

describe("LlmProxyLogsPage proxy filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/llm/logs");
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useProfiles).mockReturnValue({
      data: [personalProxy, orgProxy],
    } as unknown as ReturnType<typeof useProfiles>);
    vi.mocked(useUniqueUserIds).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useUniqueUserIds>);
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);
  });

  it("shows the owner email of a personal proxy alongside its name", async () => {
    const user = userEvent.setup();
    render(<LlmProxyLogsPage />);

    await openProxyFilter(user);

    const option = await screen.findByRole("option", { name: /My Proxy/ });
    expect(within(option).getByText("owner@example.com")).toBeVisible();
  });

  it("shows no owner email for a non-personal proxy", async () => {
    const user = userEvent.setup();
    render(<LlmProxyLogsPage />);

    await openProxyFilter(user);

    const option = await screen.findByRole("option", { name: /Shared Proxy/ });
    expect(within(option).queryByText("owner@example.com")).toBeNull();
  });

  // This page keeps its filter in the URL rather than local state, so picking a
  // proxy is observable as the query params it writes (and the session query
  // re-derives from there on the next render).
  it("filters sessions by the picked proxy, back on the first page", async () => {
    const user = userEvent.setup();
    render(<LlmProxyLogsPage />);

    await openProxyFilter(user);
    await user.click(await screen.findByText("My Proxy"));

    expect(push).toHaveBeenCalledWith(
      expect.stringContaining("profileId=p1"),
      expect.anything(),
    );
    expect(push).toHaveBeenCalledWith(
      expect.stringContaining("page=1"),
      expect.anything(),
    );
  });

  it("presents session context and usage without separate source and details columns", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            sessionId: "demo-session",
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            lastUserMessagePreview: "Summarize the quarterly report",
            requestCount: 3,
            totalInputTokens: 100,
            totalCacheReadTokens: 50,
            totalCacheWriteTokens: 50,
            models: ["gpt-5.4", "gpt-5.4-mini"],
            userNames: ["Demo Admin"],
          }),
        ],
        pagination: { total: 1 },
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    for (const header of [
      "Session",
      "Agent",
      "Model",
      "Usage",
      "Spend",
      "Last request",
    ]) {
      expect(
        screen.getByRole("columnheader", { name: header }),
      ).toBeInTheDocument();
    }
    expect(screen.getByText("Summarize the quarterly report")).toBeVisible();
    expect(screen.getByText("3 requests")).toBeVisible();
    expect(screen.getByText("25% cache read")).toBeVisible();
    expect(screen.getByText("+1 more")).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Details" })).toBeNull();
  });

  // Naming the key is the point: a shared-key session used to render only
  // "No user — shared key", which says a virtual key was used but not which.
  it("names the virtual key a session ran on", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            userNames: [],
            unattributedReason: "shared_virtual_key",
            virtualKeys: [
              {
                id: "vk-1",
                name: "ci-runners",
                scope: "org",
                keyType: "standard",
                tokenStart: "archestra_ab",
                ownerUserId: null,
                ownerUserName: null,
              },
            ],
          }),
        ],
        pagination: { total: 1 },
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(screen.getByText("ci-runners")).toBeVisible();
    expect(screen.getByText("No user — shared key")).toBeVisible();
  });

  it("names the key and its owner for an attributed session", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            userNames: ["Demo Admin"],
            unattributedReason: null,
            virtualKeys: [
              {
                id: "vk-2",
                name: "demo-admin-laptop",
                scope: "personal",
                keyType: "standard",
                tokenStart: "archestra_cd",
                ownerUserId: "u-1",
                ownerUserName: "Demo Admin",
              },
            ],
          }),
        ],
        pagination: { total: 1 },
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(screen.getByText("demo-admin-laptop")).toBeVisible();
    expect(screen.getByText("Demo Admin")).toBeVisible();
  });

  it("shows no key badge for a session that used none", () => {
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: {
        data: [
          makeSessionSummary({
            profileId: orgProxy.id,
            profileName: orgProxy.name,
            userNames: [],
            unattributedReason: "provider_key",
            virtualKeys: [],
          }),
        ],
        pagination: { total: 1 },
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useInteractionSessions>);

    render(<LlmProxyLogsPage />);

    expect(screen.getByText("No user — provider key")).toBeVisible();
    expect(screen.queryByText(/archestra_/)).toBeNull();
  });
});
