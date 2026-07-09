import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");

const markMutate = vi.fn();
const mockSeenQuery: { data?: { items: string[] }; isSuccess: boolean } = {
  data: { items: [] },
  isSuccess: true,
};

vi.mock("@/lib/onboarding/onboarding.query", () => ({
  useSeenNavItems: () => mockSeenQuery,
  useMarkNavItemsSeen: () => ({ mutate: markMutate }),
}));

import { usePathname } from "next/navigation";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import { useNavOnboarding } from "./use-nav-onboarding";

const allPermissions = {
  "/projects": true,
  "/apps": true,
  "/llm/model-providers": true,
  "/mcp/registry": true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSeenQuery.data = { items: [] };
  mockSeenQuery.isSuccess = true;
  vi.mocked(usePathname).mockReturnValue("/chat");
  vi.mocked(usePermissionMap).mockReturnValue(allPermissions);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});

describe("useNavOnboarding", () => {
  it("shows all dots for a fresh user, including the aggregates", () => {
    const { result } = renderHook(() => useNavOnboarding());

    expect(result.current.unseenKeys).toEqual(
      new Set([
        "nav:projects",
        "nav:apps",
        "nav:connect",
        "nav:model-providers",
        "nav:mcp-registry",
      ]),
    );
    expect(result.current.showChatsDot).toBe(true);
    expect(result.current.showStudioDot).toBe(true);
    expect(result.current.showCollapsedToggleDot).toBe(true);
  });

  it("keeps dots hidden while the seen query is still loading (no flash)", () => {
    mockSeenQuery.isSuccess = false;
    mockSeenQuery.data = undefined;

    const { result } = renderHook(() => useNavOnboarding());

    expect(result.current.unseenKeys.size).toBe(0);
    expect(result.current.showStudioDot).toBe(false);
    expect(result.current.showCollapsedToggleDot).toBe(false);
    expect(markMutate).not.toHaveBeenCalled();
  });

  it("excludes RBAC-hidden items and does not roll them up into aggregates", () => {
    mockSeenQuery.data = { items: ["nav:projects", "nav:apps", "nav:connect"] };
    vi.mocked(usePermissionMap).mockReturnValue({
      ...allPermissions,
      "/llm/model-providers": false,
      "/mcp/registry": false,
    });

    const { result } = renderHook(() => useNavOnboarding());

    expect(result.current.unseenKeys.size).toBe(0);
    expect(result.current.showStudioDot).toBe(false);
    expect(result.current.showCollapsedToggleDot).toBe(false);
  });

  it("hides permission-gated chats items independently", () => {
    vi.mocked(usePermissionMap).mockReturnValue({
      ...allPermissions,
      "/projects": false,
      "/apps": false,
    });

    const { result } = renderHook(() => useNavOnboarding());

    expect(result.current.unseenKeys.has("nav:projects")).toBe(false);
    expect(result.current.unseenKeys.has("nav:apps")).toBe(false);
    expect(result.current.unseenKeys.has("nav:mcp-registry")).toBe(true);
  });

  it("clears the studio aggregate once all visible studio items are seen", () => {
    mockSeenQuery.data = {
      items: ["nav:model-providers", "nav:mcp-registry"],
    };

    const { result } = renderHook(() => useNavOnboarding());

    expect(result.current.showStudioDot).toBe(false);
    // Chats-side items still keep their aggregates on.
    expect(result.current.showChatsDot).toBe(true);
    expect(result.current.showCollapsedToggleDot).toBe(true);
  });

  it("clears the chats aggregate once all visible chats items are seen", () => {
    mockSeenQuery.data = {
      items: ["nav:projects", "nav:apps", "nav:connect"],
    };

    const { result } = renderHook(() => useNavOnboarding());

    expect(result.current.showChatsDot).toBe(false);
    expect(result.current.showStudioDot).toBe(true);
  });

  it("marks a dotted route as seen when the user lands on it (deep link)", () => {
    vi.mocked(usePathname).mockReturnValue("/llm/model-providers/anthropic");

    renderHook(() => useNavOnboarding());

    expect(markMutate).toHaveBeenCalledWith(
      ["nav:model-providers"],
      expect.anything(),
    );
  });

  it("does not re-mark a route that is already seen", () => {
    mockSeenQuery.data = { items: ["nav:projects"] };
    vi.mocked(usePathname).mockReturnValue("/projects");

    renderHook(() => useNavOnboarding());

    expect(markMutate).not.toHaveBeenCalled();
  });
});
