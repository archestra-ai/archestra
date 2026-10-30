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
              type: "api_conflict_error",
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
  it("keeps sparse legacy saved positions ahead of unpositioned built-ins", async () => {
    settings.popularAgentOverrides = { codex: { position: 3 } };
    mount();
    const list = await screen.findByRole("list", { name: "Agent Runtimes" });
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
        "Codex",
      ),
    );
  });

  it("refreshes after a conflict and lets Cancel start the next edit from the latest revision", async () => {
    mount();
    const user = userEvent.setup();
    const actions = await screen.findByRole("button", {
      name: "Actions for Codex",
    });
    await waitFor(() => expect(actions).toBeEnabled());
    await user.click(actions);
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    // Another administrator changes the list while this draft is open.
    settings = {
      ...settings,
      revision: 1,
      popularAgentOverrides: { opencode: { hidden: true } },
    };
    overrides = settings.popularAgentOverrides;
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Actions for OpenCode" }),
      ).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Actions for Codex" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.revision).toBe(2));
    expect(settings.popularAgentOverrides?.opencode?.hidden).toBe(true);
    expect(settings.popularAgentOverrides?.codex?.hidden).toBe(true);
  });

  it("validates, cancels, adds and persists a custom runtime across a fresh mount", async () => {
    const user = userEvent.setup();
    settings.popularAgentOverrides = { codex: { hidden: true, position: 3 } };
    // The organization query deliberately holds an older snapshot.
    const view = mount();
    const add = await screen.findByRole("button", {
      name: "Add runtime",
    });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    await user.click(
      screen.getByRole("menuitem", { name: "Create custom runtime…" }),
    );
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
    await user.click(
      screen.getByRole("menuitem", { name: "Create custom runtime…" }),
    );
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
      await screen.findByRole("button", {
        name: "Actions for Engineering workspace",
      }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Edit Codex" }),
    ).not.toBeInTheDocument();
  });

  it("edits and reorders visible entries, with cancel-safe removal and persistent add-back", async () => {
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
    const view = mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Actions for Engineering workspace",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Review workspace");
    await user.click(screen.getByRole("button", { name: "Update template" }));
    await user.click(screen.getByRole("button", { name: "Actions for Codex" }));
    expect(
      screen.queryByRole("menuitem", { name: "Edit runtime" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    expect(
      screen.queryByRole("button", { name: "Actions for Codex" }),
    ).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Reorder Review workspace" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(settings.templates[0].name).toBe("Review workspace"),
    );
    expect(settings.templates[0].position).toBeGreaterThan(0);
    expect(overrides?.codex?.hidden).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Actions for Review workspace" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Actions for Review workspace" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Actions for Review workspace" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.templates[0].hidden).toBe(true));
    expect(settings.templates[0].runtime.image).toBe(
      "registry.example.com/dev:v1",
    );
    view.unmount();
    mount();
    const add = await screen.findByRole("button", { name: "Add runtime" });
    await waitFor(() => expect(add).toBeEnabled());
    expect(
      screen.queryByRole("button", { name: "Actions for Review workspace" }),
    ).not.toBeInTheDocument();
    await user.click(add);
    await user.click(screen.getByRole("menuitem", { name: /Codex/ }));
    await user.click(add);
    await user.click(
      screen.getByRole("menuitem", { name: "Review workspace" }),
    );
    const rows = within(
      screen.getByRole("list", { name: "Agent Runtimes" }),
    ).getAllByRole("listitem");
    expect(rows.at(-2)).toHaveTextContent("Codex");
    expect(rows.at(-1)).toHaveTextContent("Review workspace");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settings.templates[0].hidden).toBe(false));
    expect(overrides?.codex?.hidden).toBe(false);
    expect(settings.templates[0].runtime.image).toBe(
      "registry.example.com/dev:v1",
    );
  });

  it("uses the built-in logo in Add runtime and restores into an empty list", async () => {
    const { AGENT_CATALOG_IDS } = await import("@archestra/shared");
    settings.popularAgentOverrides = Object.fromEntries(
      AGENT_CATALOG_IDS.map((id) => [id, { hidden: true }]),
    );
    mount();
    const user = userEvent.setup();
    const add = await screen.findByRole("button", { name: "Add runtime" });
    await waitFor(() => expect(add).toBeEnabled());
    expect(
      screen.getByText("No runtimes offered. Add a runtime to get started."),
    ).toBeInTheDocument();
    await user.click(add);
    const opencode = screen.getByRole("menuitem", { name: /OpenCode/ });
    expect(
      within(opencode).getByRole("img", { name: "OpenCode logo" }),
    ).toBeInTheDocument();
    await user.click(opencode);
    expect(
      screen.getByRole("button", { name: "Actions for OpenCode" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(overrides?.opencode?.hidden).toBe(false));
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
      name: "Add runtime",
    });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    await user.click(
      screen.getByRole("menuitem", { name: "Create custom runtime…" }),
    );
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
