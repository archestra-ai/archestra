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
        templates: body.templates.map((item) => ({
          ...item,
          locked: item.locked ?? false,
        })),
        builtIns: body.builtIns ?? {},
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
  settings = {
    revision: 0,
    templates: [],
    builtIns: {},
    popularAgentOverrides: null,
  };
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

/** A change saves on its own; the list unlocks once the save has settled. */
const saved = () =>
  waitFor(() =>
    expect(screen.getByRole("button", { name: "Add runtime" })).toBeEnabled(),
  );

describe("RuntimeTemplateSection", () => {
  it("edits and locks a built-in runtime's settings", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Actions for Claude Code" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Claude Code" });
    await user.click(
      within(dialog).getByRole("button", { name: /^Claude account/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: /^Limits/ }));
    await user.click(
      within(dialog).getByRole("combobox", { name: "Claude account" }),
    );
    await user.click(screen.getByRole("option", { name: "A company API key" }));
    await user.type(
      within(dialog).getByRole("spinbutton", { name: /Maximum duration/ }),
      "8",
    );
    await user.click(
      within(dialog).getByRole("switch", { name: "Lock settings" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    );
    // Saving the runtime is the whole save: no second button on the page.
    await waitFor(() =>
      expect(settings.builtIns["claude-code"]).toMatchObject({
        locked: true,
        settings: {
          ttlHours: 8,
          claudeCode: { authentication: "provider" },
        },
      }),
    );
  });

  it("keeps sparse legacy saved positions ahead of unpositioned built-ins", async () => {
    settings.popularAgentOverrides = { codex: { position: 3 } };
    mount();
    const list = await screen.findByRole("list", {
      name: "Available runtimes",
    });
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
        "Codex",
      ),
    );
  });

  it("puts the list back after a conflict, so the next change starts from the latest revision", async () => {
    mount();
    const user = userEvent.setup();
    const actions = await screen.findByRole("button", {
      name: "Actions for Codex",
    });
    await waitFor(() => expect(actions).toBeEnabled());
    // Another administrator changes the list while this page is open.
    settings = {
      ...settings,
      revision: 1,
      popularAgentOverrides: { opencode: { hidden: true } },
    };
    overrides = settings.popularAgentOverrides;
    await user.click(actions);
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    // The refused change is undone and the other administrator's shows.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Actions for OpenCode" }),
      ).not.toBeInTheDocument(),
    );
    const retry = await screen.findByRole("button", {
      name: "Actions for Codex",
    });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(settings.revision).toBe(1);
    await user.click(retry);
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
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
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add runtime",
      }),
    );
    expect(await screen.findByText("Enter a name")).toBeInTheDocument();
    expect(screen.getByText("Enter a container image")).toBeInTheDocument();
    await user.click(screen.getByRole("textbox", { name: "Name" }));
    await user.paste("Canceled workspace");
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
    await user.click(screen.getByRole("textbox", { name: "Name" }));
    await user.paste("Engineering workspace");
    await user.click(screen.getByRole("textbox", { name: "Description" }));
    await user.paste("Standard development tools");
    await user.click(screen.getByRole("textbox", { name: "Container image" }));
    await user.paste("registry.example.com/engineering:v1");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add runtime",
      }),
    );
    await waitFor(() => expect(settings.templates).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
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
        locked: false,
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
    await user.click(screen.getByRole("button", { name: "Save runtime" }));
    await waitFor(() =>
      expect(settings.templates[0].name).toBe("Review workspace"),
    );
    await saved();
    await user.click(screen.getByRole("button", { name: "Actions for Codex" }));
    expect(
      screen.getByRole("menuitem", { name: "Edit runtime" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    await waitFor(() => expect(overrides?.codex?.hidden).toBe(true));
    await saved();
    expect(
      screen.queryByRole("button", { name: "Actions for Codex" }),
    ).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Reorder Review workspace" }).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(settings.templates[0].position).toBeGreaterThan(0),
    );
    await saved();
    await user.click(
      screen.getByRole("button", { name: "Actions for Review workspace" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
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
    await waitFor(() => expect(overrides?.codex?.hidden).toBe(false));
    await saved();
    await user.click(add);
    await user.click(
      screen.getByRole("menuitem", { name: "Review workspace" }),
    );
    const rows = within(
      screen.getByRole("list", { name: "Available runtimes" }),
    ).getAllByRole("listitem");
    expect(rows.at(-2)).toHaveTextContent("Codex");
    expect(rows.at(-1)).toHaveTextContent("Review workspace");
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
    await waitFor(() => expect(overrides?.opencode?.hidden).toBe(false));
  });

  it("turns custom images off, keeps that through a reorder, and turns them back on", async () => {
    const view = mount();
    const user = userEvent.setup();
    const toggle = await screen.findByRole("switch", {
      name: "Allow custom images",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect(overrides?.["custom-image"]).toEqual({ hidden: true }),
    );
    await saved();
    // Not a runtime, so it is not offered beside the removed ones.
    await user.click(screen.getByRole("button", { name: "Add runtime" }));
    expect(
      screen.queryByRole("menuitem", { name: /Custom image/ }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    screen.getByRole("button", { name: "Reorder Codex" }).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(overrides?.codex?.position).toBeGreaterThan(0));
    expect(overrides?.["custom-image"]).toEqual({ hidden: true });
    view.unmount();
    mount();
    const restored = await screen.findByRole("switch", {
      name: "Allow custom images",
    });
    await waitFor(() => expect(restored).toBeEnabled());
    expect(restored).not.toBeChecked();
    await user.click(restored);
    await waitFor(() =>
      expect(overrides?.["custom-image"]).toEqual({ hidden: false }),
    );
  });

  it("appends new templates after existing choices when saved positions contain gaps", async () => {
    settings.templates = [999, 1000].map((position, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      name: `Existing workspace ${index + 1}`,
      description: "Existing configuration",
      icon: null,
      hidden: false,
      locked: false,
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
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add runtime",
      }),
    );
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
