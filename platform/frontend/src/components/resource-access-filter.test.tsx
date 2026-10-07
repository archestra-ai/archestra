import type { ResourceAccessRelation } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type ResourceAccessCountParams,
  ResourceAccessFilter,
  useResourceAccessParam,
} from "./resource-access-filter";
import { useScopeFilterParams } from "./resource-scope-filter";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/agent.query", () => ({
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
}));

const push = vi.fn();
function setQuery(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(usePathname).mockReturnValue("/agents");
  setQuery("");
  setReadsEveryObject(true);
});

function setReadsEveryObject(value: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: value,
  } as ReturnType<typeof useHasPermissions>);
}

describe("resource access filter", () => {
  it("hides other people's objects until the viewer asks for them", () => {
    const { result } = renderHook(() => useResourceAccessParam());
    expect(result.current).toEqual({
      access: ["mine", "shared", "org"],
      isDefault: true,
    });
  });

  it("reads a bookmarked selection and counts it as an active filter", () => {
    setQuery("access=others,mine");
    expect(renderHook(() => useScopeFilterParams()).result.current).toEqual(
      expect.objectContaining({
        access: ["mine", "others"],
        hasActiveScopeFilters: true,
      }),
    );
  });

  it("falls back to the default when the parameter holds nothing usable", () => {
    setQuery("access=bogus");
    expect(renderHook(() => useResourceAccessParam()).result.current).toEqual({
      access: ["mine", "shared", "org"],
      isDefault: true,
    });
  });

  it("adds the admin option to the URL and resets the page", async () => {
    setQuery("page=3&name=x");
    renderFilter();
    const user = userEvent.setup();
    await openFilter(user);
    await user.click(option(/Not shared with me/));
    expect(push).toHaveBeenCalledWith(
      "/agents?name=x&access=mine%2Cshared%2Corg%2Cothers",
      { scroll: false },
    );
  });

  it("drops the parameter when the selection returns to the default", async () => {
    setQuery("access=mine,shared,org,others");
    renderFilter();
    expect(trigger()).toHaveTextContent("All agents");
    const user = userEvent.setup();
    await openFilter(user);
    await user.click(option(/Not shared with me/));
    expect(push).toHaveBeenCalledWith("/agents?", { scroll: false });
  });

  it("names the default selection after the listed objects", () => {
    renderFilter({ noun: "knowledge bases" });
    expect(trigger()).toHaveTextContent("Knowledge bases I can access");
  });

  it("offers the admin option only to a viewer who reads every object of the type", async () => {
    setReadsEveryObject(false);
    renderFilter();
    const user = userEvent.setup();
    await openFilter(user);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(
      screen.queryByRole("checkbox", { name: /Not shared with me/ }),
    ).not.toBeInTheDocument();
    expect(useHasPermissions).toHaveBeenCalledWith({ agent: ["read"] }, "*");
  });

  it("keeps a bookmarked admin selection clearable without that access", async () => {
    setReadsEveryObject(false);
    setQuery("access=mine,others");
    renderFilter();
    const user = userEvent.setup();
    await openFilter(user);
    expect(option(/Not shared with me/)).toBeInTheDocument();
  });

  it("keeps the last remaining relation selected", async () => {
    setQuery("access=mine");
    renderFilter();
    const user = userEvent.setup();
    await openFilter(user);
    expect(option(/^Mine/)).toHaveAttribute("aria-disabled", "true");
    await user.click(option(/^Mine/));
    expect(push).not.toHaveBeenCalled();
  });

  it("counts each option and the selection only once the filter is open", async () => {
    const countItems = vi.fn(async ({ access }: ResourceAccessCountParams) =>
      access.reduce((sum, relation) => sum + COUNTS[relation], 0),
    );
    renderFilter({ countItems });
    expect(countItems).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await openFilter(user);
    expect(await screen.findByText(fullText("1 of 11 agents"))).toBeVisible();
    expect(option(/^Mine/)).toHaveTextContent("1");
    expect(option(/Not shared with me/)).toHaveTextContent("10");
  });

  it("adds the built-in agents on top of the selection", async () => {
    const countItems = vi.fn(
      async ({ access, includeBuiltIn }: ResourceAccessCountParams) =>
        access.reduce((sum, relation) => sum + COUNTS[relation], 0) +
        (includeBuiltIn ? 5 : 0),
    );
    renderFilter({ countItems, offerBuiltIn: true });
    const user = userEvent.setup();
    await openFilter(user);
    await waitFor(() => expect(option(/Built-in/)).toHaveTextContent("5"));
    await user.click(option(/Built-in/));
    expect(push).toHaveBeenCalledWith("/agents?builtIn=true", {
      scroll: false,
    });
  });

  it("offers built-in agents only to agent admins", async () => {
    setReadsEveryObject(false);
    renderFilter({ offerBuiltIn: true });
    const user = userEvent.setup();
    await openFilter(user);
    expect(
      screen.queryByRole("checkbox", { name: /Built-in/ }),
    ).not.toBeInTheDocument();
  });

  it("resets the selection and the built-in option together", async () => {
    setQuery("access=mine&builtIn=true&name=x");
    renderFilter({ offerBuiltIn: true });
    expect(trigger()).toHaveTextContent("+ Built-in");
    const user = userEvent.setup();
    await openFilter(user);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(push).toHaveBeenCalledWith("/agents?name=x", { scroll: false });
  });
});

const COUNTS: Record<ResourceAccessRelation, number> = {
  mine: 1,
  shared: 0,
  org: 0,
  others: 10,
};

function renderFilter(
  props: Partial<ComponentProps<typeof ResourceAccessFilter>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ResourceAccessFilter
        resource="agent"
        noun="agents"
        countItems={async () => 0}
        {...props}
      />
    </QueryClientProvider>,
  );
}

function trigger() {
  return screen.getByRole("button", { name: "Filter by access" });
}

async function openFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
}

/** Matches the innermost element whose whole text, across spans, is `text`. */
function fullText(text: string) {
  return (_: string, element: Element | null) =>
    element?.textContent === text &&
    [...element.children].every((child) => child.textContent !== text);
}

function option(name: RegExp) {
  return screen.getByRole("checkbox", { name });
}
