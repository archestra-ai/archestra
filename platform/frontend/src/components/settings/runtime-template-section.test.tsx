import {
  archestraApiClient,
  type archestraApiTypes,
  buildCustomAgentRuntime,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
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
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { makeOrganization } from "@/mocks/data/organization";
import { RuntimeTemplateSection } from "./runtime-template-section";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

type Settings = archestraApiTypes.GetRuntimeTemplateSettingsResponses["200"];
let settings: Settings;
let overrides: archestraApiTypes.SaveRuntimeTemplateSettingsData["body"]["popularAgentOverrides"];
const server = setupServer(
  http.get("http://localhost:9000/api/organization", () =>
    HttpResponse.json(makeOrganization({ popularAgentOverrides: overrides })),
  ),
  http.get("http://localhost:9000/api/agent-runtime-templates/settings", () =>
    HttpResponse.json(settings),
  ),
  http.get("http://localhost:9000/api/agent-runtime-templates", () =>
    HttpResponse.json(
      settings.templates.map(({ runtime, ...item }) => ({
        ...item,
        image: runtime.image,
      })),
    ),
  ),
  http.get("http://localhost:9000/api/credentials", () =>
    HttpResponse.json([]),
  ),
  http.put(
    "http://localhost:9000/api/agent-runtime-templates/settings",
    async ({ request }) => {
      const body =
        (await request.json()) as archestraApiTypes.SaveRuntimeTemplateSettingsData["body"];
      if (body.revision !== settings.revision)
        return HttpResponse.json(
          {
            error: {
              message:
                "Runtime templates changed. Reload the settings before saving again.",
            },
          },
          { status: 409 },
        );
      settings = {
        revision: body.revision + 1,
        templates: body.templates,
        popularAgentOverrides: body.popularAgentOverrides,
      };
      overrides = body.popularAgentOverrides;
      return HttpResponse.json(settings);
    },
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
beforeEach(() => {
  settings = { revision: 0, templates: [], popularAgentOverrides: null };
  overrides = null;
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "admin" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useFeature).mockImplementation((flag) =>
    flag === "agentRuntime" ? true : undefined,
  );
  vi.mocked(useAppName).mockReturnValue("Test Platform");
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RuntimeTemplateSection />
    </QueryClientProvider>,
  );
}

describe("RuntimeTemplateSection", () => {
  it("validates, cancels, adds and persists a custom runtime across a fresh mount", async () => {
    const user = userEvent.setup();
    settings.popularAgentOverrides = { codex: { hidden: true, position: 3 } };
    // The organization query deliberately holds an older snapshot.
    const view = mount();
    const add = await screen.findByRole("button", {
      name: "Add custom runtime",
    });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    await user.click(screen.getByRole("button", { name: "Add template" }));
    expect(await screen.findByText("Enter a name")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "Canceled workspace",
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await user.click(add);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "Engineering workspace",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Description" }),
      "Standard development tools",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Container image" }),
      "registry.example.com/engineering:v1",
    );
    await user.click(screen.getByRole("button", { name: "Add template" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.templates).toHaveLength(1));
    expect(overrides?.codex?.hidden).toBe(true);
    expect(settings.templates[0]).toMatchObject({
      name: "Engineering workspace",
      description: "Standard development tools",
      runtime: {
        image: "registry.example.com/engineering:v1",
        privileged: false,
      },
    });
    view.unmount();
    mount();
    expect(
      await screen.findByRole("button", { name: "Edit Engineering workspace" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Edit Codex" }),
    ).not.toBeInTheDocument();
  });

  it("edits, reorders, hides and deletes custom entries with cancel-safe changes", async () => {
    settings.templates = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Engineering workspace",
        description: "Development",
        icon: null,
        hidden: false,
        position: 0,
        runtime: {
          ...buildCustomAgentRuntime({ image: "registry.example.com/dev:v1" }),
          privileged: false,
        },
      },
    ];
    mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Engineering workspace" }),
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Review workspace");
    await user.click(screen.getByRole("button", { name: "Update template" }));
    await user.click(
      screen.getByRole("switch", { name: "Offer Codex when creating agents" }),
    );
    await user.keyboard("{Tab}");
    await screen
      .getByRole("button", { name: "Reorder Review workspace" })
      .focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(settings.templates[0].name).toBe("Review workspace"),
    );
    expect(settings.templates[0].position).toBeGreaterThan(0);
    expect(overrides?.codex?.hidden).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Delete Review workspace" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Edit Review workspace" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete Review workspace" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete template" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Edit Review workspace" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete Review workspace" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete template" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.templates).toEqual([]));
  });
  it("appends new templates after existing choices when saved positions contain gaps", async () => {
    settings.templates = [999, 1000].map((position, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      name: `Existing workspace ${index + 1}`,
      description: "Existing configuration",
      icon: null,
      hidden: false,
      position,
      runtime: {
        ...buildCustomAgentRuntime({
          image: "registry.example.com/existing:v1",
        }),
        privileged: false as const,
      },
    }));
    mount();
    const user = userEvent.setup();
    const add = await screen.findByRole("button", {
      name: "Add custom runtime",
    });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "New workspace",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Container image" }),
      "registry.example.com/new:v1",
    );
    await user.click(screen.getByRole("button", { name: "Add template" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.templates).toHaveLength(3));
    const ordered = [...settings.templates].sort(
      (a, b) => a.position - b.position,
    );
    expect(ordered.map((item) => item.name)).toEqual([
      "Existing workspace 1",
      "Existing workspace 2",
      "New workspace",
    ]);
    expect(ordered.at(-1)?.position).toBeLessThan(1000);
  });
});
