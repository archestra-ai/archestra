import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationAppAccessNotice } from "./conversation-app-access-notice";

type StubApp = {
  id: string;
  name: string;
  scope: "personal" | "team" | "org";
  enabled: boolean;
  teams: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string; email: string }>;
};

let appsById: Record<string, StubApp> = {};

// Hoisted so the `vi.mock` factory below (which is lifted above these
// declarations) can close over it; the implementation is attached in beforeEach,
// by which point `appsById` exists.
const mockGetApp = vi.hoisted(() => vi.fn());

vi.mock("@archestra/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@archestra/shared")>(
      "@archestra/shared",
    );
  return {
    ...actual,
    archestraApiSdk: { ...actual.archestraApiSdk, getApp: mockGetApp },
  };
});

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

function makeApp(overrides: Partial<StubApp> & { id: string }): StubApp {
  return {
    name: `App ${overrides.id}`,
    scope: "personal",
    enabled: true,
    teams: [],
    users: [],
    ...overrides,
  };
}

function renderNotice(props: {
  appIds: string[];
  visibility: "private" | "organization" | "team" | "user";
  teamIds?: string[];
  userIds?: string[];
}) {
  return render(
    <ConversationAppAccessNotice
      appIds={props.appIds}
      visibility={props.visibility}
      teamIds={props.teamIds ?? []}
      userIds={props.userIds ?? []}
    />,
    { wrapper: createWrapper() },
  );
}

/** The warning headline, whichever singular/plural form it took. */
const warning = () => screen.queryByText(/won't open for everyone/i);

beforeEach(() => {
  vi.clearAllMocks();
  appsById = {};
  mockGetApp.mockImplementation(
    async ({ path }: { path: { appId: string } }) => {
      const app = appsById[path.appId];
      return app
        ? { data: app, error: undefined }
        : { data: undefined, error: { type: "api_not_found_error" } };
    },
  );
});

describe("ConversationAppAccessNotice", () => {
  it("warns that a personal app in the chat won't open for recipients", async () => {
    appsById.a = makeApp({ id: "a", name: "Ad Spend", scope: "personal" });

    renderNotice({ appIds: ["a"], visibility: "user" });

    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(screen.getByText("Ad Spend")).toBeInTheDocument();
    // The point of the warning: these are two separate grants.
    expect(
      screen.getByText(/sharing a chat doesn't share the apps inside it/i),
    ).toBeInTheDocument();
  });

  it("stays silent for an org-scoped app, which every recipient can already open", async () => {
    appsById.a = makeApp({ id: "a", scope: "org" });

    renderNotice({ appIds: ["a"], visibility: "organization" });

    await waitFor(() => expect(mockGetApp).toHaveBeenCalled());
    expect(warning()).not.toBeInTheDocument();
  });

  it("stays silent while the chat is still private", async () => {
    appsById.a = makeApp({ id: "a", scope: "personal" });

    renderNotice({ appIds: ["a"], visibility: "private" });

    expect(warning()).not.toBeInTheDocument();
  });

  it("stays silent for a team app shared with exactly the teams that hold it", async () => {
    appsById.a = makeApp({
      id: "a",
      scope: "team",
      teams: [{ id: "team-1", name: "Design" }],
    });

    renderNotice({
      appIds: ["a"],
      visibility: "team",
      teamIds: ["team-1"],
    });

    await waitFor(() => expect(mockGetApp).toHaveBeenCalled());
    expect(warning()).not.toBeInTheDocument();
  });

  it("warns when a team share reaches past the teams holding the app", async () => {
    appsById.a = makeApp({
      id: "a",
      name: "Design Tool",
      scope: "team",
      teams: [{ id: "team-1", name: "Design" }],
    });

    renderNotice({
      appIds: ["a"],
      visibility: "team",
      teamIds: ["team-1", "team-2"],
    });

    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(screen.getByText("Design Tool")).toBeInTheDocument();
  });

  it("warns for a team app shared with individual users, who need not be on that team", async () => {
    appsById.a = makeApp({
      id: "a",
      scope: "team",
      teams: [{ id: "team-1", name: "Design" }],
    });

    renderNotice({ appIds: ["a"], visibility: "user" });

    await waitFor(() => expect(warning()).toBeInTheDocument());
  });

  it("warns about a disabled app, which is author-only whatever its scope", async () => {
    appsById.a = makeApp({
      id: "a",
      name: "Paused",
      scope: "org",
      enabled: false,
    });

    renderNotice({ appIds: ["a"], visibility: "organization" });

    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("names only the apps recipients cannot open", async () => {
    appsById.a = makeApp({ id: "a", name: "Private One", scope: "personal" });
    appsById.b = makeApp({ id: "b", name: "Shared One", scope: "org" });

    renderNotice({ appIds: ["a", "b"], visibility: "organization" });

    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(screen.getByText("Private One")).toBeInTheDocument();
    expect(screen.queryByText("Shared One")).not.toBeInTheDocument();
  });

  it("stays silent when every recipient already holds a grant on the app", async () => {
    appsById.a = makeApp({
      id: "a",
      scope: "personal",
      users: [
        { id: "user-1", name: "Ada", email: "ada@example.com" },
        { id: "user-2", name: "Grace", email: "grace@example.com" },
      ],
    });

    renderNotice({
      appIds: ["a"],
      visibility: "user",
      userIds: ["user-1", "user-2"],
    });

    await waitFor(() => expect(mockGetApp).toHaveBeenCalled());
    expect(warning()).not.toBeInTheDocument();
  });

  it("warns when a recipient is missing a grant, even if others have one", async () => {
    appsById.a = makeApp({
      id: "a",
      name: "Half Shared",
      scope: "personal",
      users: [{ id: "user-1", name: "Ada", email: "ada@example.com" }],
    });

    renderNotice({
      appIds: ["a"],
      visibility: "user",
      userIds: ["user-1", "user-2"],
    });

    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(screen.getByText("Half Shared")).toBeInTheDocument();
  });

  it("warns for an org-wide chat share even when named grants exist", async () => {
    // Grants cover named people, not the whole organization.
    appsById.a = makeApp({
      id: "a",
      scope: "personal",
      users: [{ id: "user-1", name: "Ada", email: "ada@example.com" }],
    });

    renderNotice({ appIds: ["a"], visibility: "organization" });

    await waitFor(() => expect(warning()).toBeInTheDocument());
  });

  it("says nothing about an app the sharer cannot read, rather than guessing", async () => {
    renderNotice({ appIds: ["gone"], visibility: "organization" });

    await waitFor(() => expect(mockGetApp).toHaveBeenCalled());
    expect(warning()).not.toBeInTheDocument();
  });
});
