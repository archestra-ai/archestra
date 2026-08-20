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

vi.mock("@/lib/agent.query", () => ({ useProfiles: vi.fn() }));
vi.mock("@/lib/interactions/interaction.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/interactions/interaction.query")
  >()),
  useInteractionSessions: vi.fn(),
  useUniqueUserIds: vi.fn(),
}));

// Two users can each name their own proxy "My Proxy", so the filter has to
// carry enough context to tell them apart.
const personalProxy = {
  id: "p1",
  name: "My Proxy",
  agentType: "llm_proxy",
  scope: "personal",
  authorEmail: "owner@example.com",
};

const orgProxy = {
  id: "p2",
  name: "Shared Proxy",
  agentType: "llm_proxy",
  scope: "org",
};

const push = vi.fn();

// role="combobox" takes no accessible name from its contents, so the trigger is
// addressed by the label it renders.
async function openProxyFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("All Agents & LLM Proxies"));
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
});
