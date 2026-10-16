import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { EditProjectDialog } from "./edit-project-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");
vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
const scrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "owner" } },
  } as ReturnType<typeof useSession>);
});
afterEach(() => {
  server.resetHandlers();
  if (scrollIntoView)
    Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
afterAll(() => server.close());

it.each([
  false,
  true,
])("keeps the named-user shared pin through pending/error lookup (fail first: %s) and offers all eligible agents", async (failFirst) => {
  const project = {
    id: "project-1",
    name: "Shared notes",
    description: null,
    icon: null,
    labels: [],
    viewerRole: "owner",
    visibility: "user",
    shareTeamIds: [],
    shareUserIds: ["owner", "colleague"],
    defaultAgent: { id: "selected-agent", name: "Saved helper" },
  };
  const saved: unknown[] = [];
  let releaseReference!: () => void;
  const heldReference = new Promise<void>((resolve) => {
    releaseReference = resolve;
  });
  let selectedReadStarted = false;
  let referenceAttempts = 0;
  server.use(
    http.get(`${origin}/api/projects/project-1`, () =>
      HttpResponse.json(project),
    ),
    http.get(`${origin}/api/agents/options/page`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get("audienceVisibility")).toBe("user");
      expect(params.get("audienceUserIds")).toBe("owner,colleague");
      return HttpResponse.json({
        data: [
          {
            id: "selected-agent",
            name: "Saved helper",
            agentType: "agent",
            scope: "personal",
            authorId: "owner",
            users: [{ id: "colleague" }],
          },
          {
            id: "alternative-agent",
            name: "Another shared helper",
            agentType: "agent",
            scope: "personal",
            authorId: "colleague",
            users: [{ id: "owner" }],
          },
          {
            id: "private-agent",
            name: "Private helper",
            agentType: "agent",
            scope: "personal",
            authorId: "owner",
            users: [],
          },
        ].filter((agent) => agent.id !== "private-agent"),
        pagination: { limit: 20, hasNext: false, nextCursor: null },
      });
    }),
    http.get(`${origin}/api/agents/options`, async ({ request }) => {
      expect(new URL(request.url).searchParams.get("ids")).toBe(
        "selected-agent",
      );
      selectedReadStarted = true;
      const isAudienceCheck =
        new URL(request.url).searchParams.get("excludeBuiltIn") === "true";
      if (isAudienceCheck) referenceAttempts += 1;
      const rejectReference =
        failFirst && isAudienceCheck && referenceAttempts === 1;
      await heldReference;
      if (rejectReference)
        return HttpResponse.json(
          { error: { message: "Temporarily unavailable" } },
          { status: 503 },
        );
      return HttpResponse.json([
        {
          id: "selected-agent",
          name: "Saved helper",
          agentType: "agent",
          scope: "personal",
          authorId: "owner",
          users: [{ id: "colleague" }],
        },
      ]);
    }),
    http.get(`${origin}/api/resource-permissions/project/project-1`, () =>
      HttpResponse.json({
        resource: "project",
        scope: "project-1",
        name: project.name,
        revision: 1,
        grants: [],
        inheritedGrants: [],
        actorSubjects: [],
        effectiveActions: ["read", "update", "manage-permissions"],
      }),
    ),
    http.get(`${origin}/api/profiles/labels/keys`, () => HttpResponse.json([])),
    http.get(`${origin}/api/bootstrap`, () => HttpResponse.json({})),
    http.patch(`${origin}/api/projects/project-1`, async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json(project);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <EditProjectDialog projectId="project-1" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(selectedReadStarted).toBe(true));
  expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  releaseReference();
  if (failFirst) {
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry agent lookup" }),
    );
  }
  await screen.findByText("Saved helper");
  const trigger = screen
    .getAllByRole("combobox")
    .find((element) => element.textContent?.includes("Saved helper"));
  if (!trigger) throw new Error("Saved agent picker is unavailable");
  await userEvent.click(trigger);
  expect(await screen.findByText("Another shared helper")).toBeVisible();
  expect(screen.queryByText("Private helper")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(saved).toHaveLength(1));
  // An untouched default is omitted from PATCH, preserving the existing pin.
  expect(saved[0]).not.toHaveProperty("defaultAgentId");
  queryClient.clear();
});
