import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ComponentProps } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  ResourceAccessFilter,
  useResourceAccessParam,
} from "./resource-access-filter";
import { useScopeFilterParams } from "./resource-scope-filter";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/agent.query", () => ({
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
}));

const origin = "http://localhost:9000";
const subjectsEndpoint = `${origin}/api/resource-permissions/:resource/:scope/subjects`;
const server = setupServer();
// Deliberately out of display order, so the grouping is the component's.
const recipients = [
  {
    subject: {
      type: "serviceAccount",
      id: "00000000-0000-4000-8000-000000000011",
    },
    name: "Release automation",
  },
  {
    subject: { type: "user", id: "user-alex" },
    name: "Alex Reader",
    email: "alex@example.com",
  },
  {
    subject: { type: "user", id: "user-me" },
    name: "Sam Viewer",
    email: "sam@example.com",
  },
  { subject: { type: "team", id: "team-eng" }, name: "Engineering" },
  { subject: { type: "role", id: "editor" }, name: "Editor" },
  {
    subject: { type: "organization", id: "*" },
    name: "Everyone in the organization",
  },
];
const subjectRequests: Array<{ resource: string; scope: string }> = [];

const push = vi.fn();
function setQuery(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: origin });
  subjectRequests.length = 0;
  server.use(
    http.get(subjectsEndpoint, ({ params }) => {
      subjectRequests.push({
        resource: String(params.resource),
        scope: String(params.scope),
      });
      return HttpResponse.json(recipients);
    }),
  );
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(usePathname).mockReturnValue("/agents");
  vi.mocked(useSession).mockReturnValue({
    data: {
      user: { id: "user-me", name: "Sam Viewer", email: "sam@example.com" },
    },
  } as unknown as ReturnType<typeof useSession>);
  setQuery("");
  setReadsEveryObject(true);
  vi.mocked(useAppName).mockReturnValue("Acme AI");
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function setReadsEveryObject(value: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: value,
  } as ReturnType<typeof useHasPermissions>);
}

describe("access filter parameters", () => {
  it("hides other people's objects and filters nothing else by default", () => {
    const { result } = renderHook(() => useResourceAccessParam());
    expect(result.current).toEqual({
      access: ["mine", "shared", "org"],
      sharedWith: undefined,
      owner: undefined,
      isDefault: true,
    });
  });

  it("reads a bookmarked selection of all three filters as active", () => {
    setQuery("access=others,mine&sharedWith=team:team-eng,org&owner=user-alex");
    expect(renderHook(() => useScopeFilterParams()).result.current).toEqual(
      expect.objectContaining({
        access: ["mine", "others"],
        sharedWith: ["team:team-eng", "org"],
        owner: ["user-alex"],
        hasActiveScopeFilters: true,
      }),
    );
  });

  it("counts a recipient or owner alone as an active filter", () => {
    setQuery("owner=user-alex");
    expect(
      renderHook(() => useScopeFilterParams()).result.current
        .hasActiveScopeFilters,
    ).toBe(true);
  });

  it("falls back to the default when the access parameter holds nothing usable", () => {
    setQuery("access=bogus");
    expect(renderHook(() => useResourceAccessParam()).result.current).toEqual(
      expect.objectContaining({
        access: ["mine", "shared", "org"],
        isDefault: true,
      }),
    );
  });
});

describe("access box", () => {
  it("names the default selection by its options", () => {
    renderFilter({ noun: "knowledge bases" });
    expect(accessTrigger()).toHaveTextContent("Mine · Shared with me");
  });

  it("turns Shared with me off as both the shared and organization relations", async () => {
    setQuery("page=3&name=x");
    renderFilter();
    const user = userEvent.setup();
    await user.click(accessTrigger());
    expect(option(/^Shared with me/)).toHaveTextContent(
      "with you, your team, your role or everyone",
    );
    await user.click(option(/^Shared with me/));
    expect(push).toHaveBeenCalledWith("/agents?name=x&access=mine", {
      scroll: false,
    });
  });

  it("adds objects nobody shared as the others relation", async () => {
    renderFilter();
    const user = userEvent.setup();
    await user.click(accessTrigger());
    await user.click(option(/^Admin access/));
    expect(push).toHaveBeenCalledWith(
      "/agents?access=mine%2Cshared%2Corg%2Cothers",
      { scroll: false },
    );
    expect(
      screen.getByText(
        "Admin access: agents nobody shared with you. You see them only because you have the Admin role.",
      ),
    ).toBeVisible();
  });

  it("drops the parameter when the selection returns to the default", async () => {
    setQuery("access=mine,shared,org,others");
    renderFilter();
    expect(accessTrigger()).toHaveTextContent("All agents");
    const user = userEvent.setup();
    await user.click(accessTrigger());
    await user.click(option(/^Admin access/));
    expect(push).toHaveBeenCalledWith("/agents?", { scroll: false });
  });

  it("offers Admin access only to a viewer who reads every object of the type", async () => {
    setReadsEveryObject(false);
    renderFilter();
    const user = userEvent.setup();
    await user.click(accessTrigger());
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(
      screen.queryByRole("checkbox", { name: /Admin access/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/You see them only/)).not.toBeInTheDocument();
    expect(useHasPermissions).toHaveBeenCalledWith({ agent: ["read"] }, "*");
  });

  it("keeps a bookmarked admin selection clearable without that access", async () => {
    setReadsEveryObject(false);
    setQuery("access=mine,others");
    renderFilter();
    const user = userEvent.setup();
    await user.click(accessTrigger());
    expect(option(/^Admin access/)).toBeInTheDocument();
  });

  it("keeps the last remaining option selected", async () => {
    setQuery("access=mine");
    renderFilter();
    const user = userEvent.setup();
    await user.click(accessTrigger());
    expect(option(/^Mine/)).toHaveAttribute("aria-disabled", "true");
    await user.click(option(/^Mine/));
    expect(push).not.toHaveBeenCalled();
  });

  it("offers built-in agents to agent admins only", async () => {
    renderFilter({ offerBuiltIn: true });
    const user = userEvent.setup();
    await user.click(accessTrigger());
    // White-labeled deployments name themselves, not the vendor.
    expect(option(/^Built-in/)).toHaveTextContent(
      "system agents that Acme AI runs for you",
    );
    await user.click(option(/^Built-in/));
    expect(push).toHaveBeenCalledWith("/agents?builtIn=true", {
      scroll: false,
    });
  });

  it("hides built-in agents from other viewers", async () => {
    setReadsEveryObject(false);
    renderFilter({ offerBuiltIn: true });
    const user = userEvent.setup();
    await user.click(accessTrigger());
    expect(
      screen.queryByRole("checkbox", { name: /Built-in/ }),
    ).not.toBeInTheDocument();
  });

  it("shows no per-option counts", async () => {
    renderFilter({ offerBuiltIn: true });
    const user = userEvent.setup();
    await user.click(accessTrigger());
    for (const checkbox of screen.getAllByRole("checkbox"))
      expect(checkbox.textContent).not.toMatch(/\d/);
    expect(screen.queryByText(/\d+ of \d+/)).not.toBeInTheDocument();
  });

  it("drops Mine and the Owner box for objects nobody authors", async () => {
    renderFilter({ resource: "llmModel", noun: "models", owned: false });
    expect(accessTrigger()).toHaveTextContent("Shared with me");
    expect(accessTrigger()).not.toHaveTextContent("Mine");
    expect(
      screen.queryByRole("button", { name: "Filter by owner" }),
    ).not.toBeInTheDocument();
    expect(sharedWithTrigger()).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(accessTrigger());
    expect(
      screen.queryByRole("checkbox", { name: /^Mine/ }),
    ).not.toBeInTheDocument();
    // The one option left cannot be turned off.
    expect(option(/^Shared with me/)).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Shared with box", () => {
  it("groups recipients like the add-access field, searched at the type's scope", async () => {
    renderFilter();
    const user = userEvent.setup();
    await user.click(sharedWithTrigger());
    expect(
      screen.getByRole("textbox", {
        name: "Search everyone, roles, teams, people, service accounts",
      }),
    ).toBeInTheDocument();
    await screen.findByRole("checkbox", { name: "Engineering" });
    const groups = within(
      screen.getByRole("group", { name: "Recipients" }),
    ).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Organization",
      "Teams",
      "People",
      "Service accounts",
    ]);
    expect(
      within(groups[0])
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.getAttribute("aria-label")),
    ).toEqual([
      "Everyone in the organization",
      "Everyone with the Editor role",
    ]);
    expect(subjectRequests[0]).toEqual({ resource: "agent", scope: "*" });
  });

  it("writes a picked team as its subject key", async () => {
    renderFilter();
    const user = userEvent.setup();
    await user.click(sharedWithTrigger());
    await user.click(
      await screen.findByRole("checkbox", { name: "Engineering" }),
    );
    expect(push).toHaveBeenCalledWith("/agents?sharedWith=team%3Ateam-eng", {
      scroll: false,
    });
  });

  it("adds the organization to a picked team and keeps the team at the top", async () => {
    setQuery("sharedWith=team:team-eng&page=2");
    renderFilter();
    expect(sharedWithTrigger()).toHaveTextContent("1");
    const user = userEvent.setup();
    await user.click(sharedWithTrigger());
    await screen.findByRole("checkbox", {
      name: "Everyone in the organization",
    });
    const selected = screen.getByRole("group", { name: "Selected" });
    expect(
      within(selected).getByRole("checkbox", { name: "Engineering" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(
      screen.getByRole("checkbox", { name: "Everyone in the organization" }),
    );
    expect(push).toHaveBeenCalledWith(
      "/agents?sharedWith=team%3Ateam-eng%2Corg",
      { scroll: false },
    );
  });

  it("clears the parameter when the last recipient is unpicked", async () => {
    setQuery("sharedWith=org");
    renderFilter();
    const user = userEvent.setup();
    await user.click(sharedWithTrigger());
    await user.click(
      within(screen.getByRole("group", { name: "Selected" })).getByRole(
        "checkbox",
        { name: "Everyone in the organization" },
      ),
    );
    expect(push).toHaveBeenCalledWith("/agents?", { scroll: false });
  });
});

describe("Owner box", () => {
  it("lists people only, with the viewer pinned first as Me", async () => {
    renderFilter();
    const user = userEvent.setup();
    await user.click(ownerTrigger());
    await screen.findByRole("checkbox", { name: "Alex Reader" });
    const names = screen
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.getAttribute("aria-label"));
    expect(names).toEqual(["Me", "Alex Reader"]);
  });

  it("writes picked people as user ids", async () => {
    renderFilter();
    const user = userEvent.setup();
    await user.click(ownerTrigger());
    await user.click(
      await screen.findByRole("checkbox", { name: "Alex Reader" }),
    );
    expect(push).toHaveBeenCalledWith("/agents?owner=user-alex", {
      scroll: false,
    });
  });

  it("writes Me as the viewer's own id", async () => {
    renderFilter();
    const user = userEvent.setup();
    await user.click(ownerTrigger());
    await user.click(screen.getByRole("checkbox", { name: "Me" }));
    expect(push).toHaveBeenCalledWith("/agents?owner=user-me", {
      scroll: false,
    });
  });
});

it("resets all three filters and the built-in option together", async () => {
  setQuery(
    "access=mine&builtIn=true&sharedWith=org&owner=user-alex&name=x&page=4",
  );
  renderFilter({ offerBuiltIn: true });
  expect(accessTrigger()).toHaveTextContent("+ Built-in");
  expect(ownerTrigger()).toHaveTextContent("1");
  const user = userEvent.setup();
  await user.click(accessTrigger());
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(push).toHaveBeenCalledWith("/agents?name=x", { scroll: false });
});

it("offers no reset while every filter is at its default", async () => {
  renderFilter();
  const user = userEvent.setup();
  await user.click(accessTrigger());
  expect(
    screen.queryByRole("button", { name: "Reset" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(sharedWithTrigger()).not.toHaveTextContent(/\d/));
});

function renderFilter(
  props: Partial<ComponentProps<typeof ResourceAccessFilter>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ResourceAccessFilter resource="agent" noun="agents" {...props} />
    </QueryClientProvider>,
  );
}

function accessTrigger() {
  return screen.getByRole("button", { name: "Filter by access" });
}

function sharedWithTrigger() {
  return screen.getByRole("button", { name: "Filter by shared with" });
}

function ownerTrigger() {
  return screen.getByRole("button", { name: "Filter by owner" });
}

function option(name: RegExp) {
  return screen.getByRole("checkbox", { name });
}
