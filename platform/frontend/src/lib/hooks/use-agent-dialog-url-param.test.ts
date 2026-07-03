"use client";

import { act, renderHook } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfile } from "@/lib/agent.query";
import { useAgentDialogUrlParam } from "./use-agent-dialog-url-param";

vi.mock("next/navigation");
vi.mock("@/lib/agent.query", () => ({
  useProfile: vi.fn(),
}));

const mockReplace = vi.fn();

type HookAgent = NonNullable<
  ReturnType<typeof useAgentDialogUrlParam>["agent"]
>;

const agentA = { id: "agent-a", name: "Agent A" } as HookAgent;

function setSearchParams(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
}

function setProfileResult(agent: HookAgent | null) {
  vi.mocked(useProfile).mockReturnValue({ data: agent } as ReturnType<
    typeof useProfile
  >);
}

describe("useAgentDialogUrlParam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/agents");
    vi.mocked(useRouter).mockReturnValue({
      replace: mockReplace,
    } as unknown as ReturnType<typeof useRouter>);
    setSearchParams("");
    setProfileResult(null);
  });

  it("open() sets the agent and writes the id param, preserving other params", () => {
    setSearchParams("page=2");

    const { result } = renderHook(() => useAgentDialogUrlParam("edit"));

    act(() => {
      result.current.open(agentA);
    });

    expect(result.current.agent).toEqual(agentA);
    expect(result.current.openedFromUrl).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith("/agents?page=2&edit=agent-a", {
      scroll: false,
    });
  });

  it("close() clears the agent and removes only the id param", () => {
    setSearchParams("edit=agent-a&page=2");
    setProfileResult(agentA);

    const { result } = renderHook(() => useAgentDialogUrlParam("edit"));

    act(() => {
      result.current.close();
    });

    expect(result.current.agent).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith("/agents?page=2", {
      scroll: false,
    });
  });

  it("removing the last param replaces with the bare pathname", () => {
    setSearchParams("view=agent-a");
    setProfileResult(agentA);

    const { result } = renderHook(() => useAgentDialogUrlParam("view"));

    act(() => {
      result.current.close();
    });

    expect(mockReplace).toHaveBeenCalledWith("/agents", { scroll: false });
  });

  it("auto-opens from a URL param once the agent loads, without rewriting the URL", () => {
    setSearchParams("edit=agent-a");
    setProfileResult(agentA);

    const { result } = renderHook(() => useAgentDialogUrlParam("edit"));

    expect(result.current.agent).toEqual(agentA);
    expect(result.current.openedFromUrl).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not open while the fetched agent does not match the URL id", () => {
    setSearchParams("edit=agent-b");
    setProfileResult(agentA);

    const { result } = renderHook(() => useAgentDialogUrlParam("edit"));

    expect(result.current.agent).toBeNull();
  });

  it("stays closed when the URL has no param", () => {
    setProfileResult(agentA);

    const { result } = renderHook(() => useAgentDialogUrlParam("edit"));

    expect(result.current.agent).toBeNull();
  });
});
