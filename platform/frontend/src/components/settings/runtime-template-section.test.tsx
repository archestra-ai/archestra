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
import { toast } from "sonner";
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
import { makeLlmProviderApiKey } from "@/mocks/data/llm-keys";
import {
  agentRuntimeTiersSeed,
  makeOrganization,
  teamsSeed,
} from "@/mocks/data/organization";
import { RuntimeTemplateSection } from "./runtime-template-section";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");
// The list's Permissions button reads the URL for its deep link, and a link
// can name the runtime whose editor opens on load.
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/agents/runtimes",
  useRouter: () => ({ replace: navigation.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

type Settings = archestraApiTypes.GetRuntimeTemplateSettingsResponses["200"];
let settings: Settings;
let overrides: archestraApiTypes.SaveRuntimeTemplateSettingsData["body"]["popularAgentOverrides"];
let agentsBehind: number;
let applied: string[];
/** The connections the administrator can pick for a runtime's agents. */
let keys: ReturnType<typeof makeLlmProviderApiKey>[];
const companyKey = (id: string, name: string, provider: string) =>
  makeLlmProviderApiKey({
    id,
    name,
    provider: provider as never,
    scope: "org",
    userId: null,
  });
const anthropicKey = companyKey(
  "key-anthropic",
  "Company Anthropic",
  "anthropic",
);
const openAiKey = companyKey("key-openai", "Company OpenAI", "openai");
const xaiKey = companyKey("key-xai", "Company xAI", "xai");
const copilotPlan = {
  ...companyKey("plan-1", "Copilot plan", "github-copilot"),
  isGithubAppKey: true,
  githubOrganization: "example-org",
  githubOrganizationName: "Example Org",
};
const model = (
  dbId: string,
  id: string,
  displayName: string,
  provider: string,
) => ({
  dbId,
  id,
  displayName,
  provider,
  isFree: false,
});
/** Each connection's models, as the model field lists them. */
const modelsByKey: Record<string, ReturnType<typeof model>[]> = {
  "key-anthropic": [
    model("model-sonnet", "claude-sonnet-4-6", "Claude Sonnet", "anthropic"),
  ],
  "key-openai": [model("model-gpt", "gpt-5", "GPT-5", "openai")],
  "key-xai": [model("model-grok", "grok-4", "Grok 4", "xai")],
  "plan-1": [
    model("model-copilot", "gpt-5", "Copilot GPT-5", "github-copilot"),
  ],
  "plan-2": [
    model("model-copilot", "gpt-5", "Copilot GPT-5", "github-copilot"),
  ],
};
const server = setupServer(
  http.get("http://localhost:9000/api/llm-provider-api-keys/available", () =>
    HttpResponse.json(keys),
  ),
  http.get("http://localhost:9000/api/llm-models/available", ({ request }) =>
    HttpResponse.json(
      modelsByKey[new URL(request.url).searchParams.get("apiKeyId") ?? ""] ??
        [],
    ),
  ),
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
  http.get("http://localhost:9000/api/organization/agent-runtime-tiers", () =>
    HttpResponse.json(agentRuntimeTiersSeed),
  ),
  http.get("http://localhost:9000/api/teams", () =>
    HttpResponse.json(teamsSeed),
  ),
  // A runtime's own permissions: none beyond the admin's.
  http.get(
    "http://localhost:9000/api/resource-permissions/:resource/:scope",
    ({ params }) =>
      HttpResponse.json({
        resource: params.resource,
        scope: params.scope,
        name: "",
        revision: 0,
        actorSubjects: [],
        canShareOrganizationWide: true,
        grants: [],
        inheritedGrants: [],
        effectiveActions: ["read", "use", "configure", "manage-permissions"],
      }),
  ),
  http.get(
    "http://localhost:9000/api/agent-runtime-templates/:id/apply-to-agents",
    () => HttpResponse.json({ agents: agentsBehind }),
  ),
  http.post(
    "http://localhost:9000/api/agent-runtime-templates/:id/apply-to-agents",
    ({ params }) => {
      applied.push(String(params.id));
      const updated = agentsBehind;
      agentsBehind = 0;
      return HttpResponse.json({ updated });
    },
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
  agentsBehind = 0;
  applied = [];
  navigation.search = "";
  navigation.replace.mockReset();
  keys = [anthropicKey, openAiKey, xaiKey];
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

/** Each change saves at once; the list takes the next one when that is done. */
const saved = () =>
  waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: /^(Add runtime|Create custom runtime)$/,
      }),
    ).toBeEnabled(),
  );

const subscriptionCard = (dialog: HTMLElement) =>
  within(dialog).getByRole("checkbox", {
    name: /Each person's Claude subscription/,
  });
const companyCard = (dialog: HTMLElement) =>
  within(dialog).getByRole("checkbox", { name: /Provider API key/ });
const BOTH =
  "People who create or edit an agent on this runtime choose whether it allows personal subscriptions, an API key, or both.";
// Nothing fixed: the empty field says who picks, and no sentence follows.
const NOTHING_FIXED = { name: "Key Each agent chooses its own key" };
const CONNECTION_FIXED =
  "Every agent on this runtime uses this API key. Set the model in each agent's settings, or choose one here.";
const BOTH_FIXED = "Every agent on this runtime uses this API key and model.";
const accountsGroup = (dialog: HTMLElement) =>
  within(dialog).getByRole("group", { name: "Credentials to use" });
const connectionField = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: /^Key/ });
const modelField = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: /^Model/ });
/** Opens a field's list and picks one of its options. */
const pick = async (
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  option: RegExp,
) => {
  await user.click(field);
  await user.click(await screen.findByRole("option", { name: option }));
};
/** A custom runtime's accounts, as the list was last saved. */
const templateAccounts = () => settings.templates[0].accounts;
/** A built-in runtime's accounts, as the list was last saved. */
const builtInAccounts = (id: keyof Settings["builtIns"]) =>
  settings.builtIns[id]?.settings.accounts;
const openBuiltIn = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(
    await screen.findByRole("button", { name: `Actions for ${name}` }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
  const dialog = screen.getByRole("dialog", {
    name: `Edit ${name} runtime`,
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Runtime settings" }),
  );
  return dialog;
};
/** The footer's way out. The dialog's own X is named Close too, and comes first. */
const footerClose = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole("button", { name: "Close" })
    .at(-1) as HTMLElement;
/**
 * Saves the open runtime. Saving never closes its settings: the toast says
 * it worked, nothing is left unsaved, so the footer's way out reads Close,
 * and Save is ready for the next change.
 */
const saveRuntime = async (
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) => {
  vi.mocked(toast.success).mockClear();
  await user.click(
    within(dialog).getByRole("button", { name: "Save runtime" }),
  );
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith("Available runtimes updated"),
  );
  await waitFor(() =>
    expect(
      within(dialog).queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(footerClose(dialog)).toBeEnabled();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    ).toBeEnabled(),
  );
};
/** Closes a runtime's settings with nothing unsaved, back to the list. */
const closeRuntime = async (
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) => {
  await user.click(footerClose(dialog));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await saved();
};

describe("RuntimeTemplateSection", () => {
  it("edits a built-in runtime's settings, then updates the agents on older ones", async () => {
    const user = userEvent.setup();
    mount();
    const openClaudeCode = async () => {
      await user.click(
        await screen.findByRole("button", { name: "Actions for Claude Code" }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
      const dialog = screen.getByRole("dialog", {
        name: "Edit Claude Code runtime",
      });
      await user.click(
        within(dialog).getByRole("button", { name: "Runtime settings" }),
      );
      return dialog;
    };
    const dialog = await openClaudeCode();
    // The section's nav names what it holds, not the image it runs.
    expect(
      within(dialog).getByRole("button", { name: /Runtime settings/ }),
    ).toHaveTextContent(/^Runtime settingsAccounts and limits$/);
    // With nothing stored the maintained runtime names no account: both
    // cards are ticked. Unticking one names the other.
    expect(subscriptionCard(dialog)).toBeChecked();
    expect(companyCard(dialog)).toBeChecked();
    await user.click(subscriptionCard(dialog));
    expect(within(dialog).getByText("Locked to an API key")).toBeVisible();
    // Each section explains its own scope in place.
    expect(
      within(dialog).getByText(
        "Updates automatically for every agent with each Test Platform release. It can't be changed.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Which credentials agents on this runtime may allow. Changes apply to every agent as soon as you save.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Default run time, spend, and tiers for new agents.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Apply saved limits to agents already on this runtime.",
      ),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByRole("spinbutton", { name: /Maximum duration/ }),
      "8",
    );
    // Existing agents follow only saved settings.
    expect(
      within(dialog).getByText(/Updates use the saved settings/),
    ).toBeInTheDocument();
    // Two agents were created on the settings being replaced.
    agentsBehind = 2;
    await user.click(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    );
    // Saving the runtime is the whole save: no second button on the page.
    await waitFor(() =>
      expect(settings.builtIns["claude-code"]).toMatchObject({
        settings: {
          ttlHours: 8,
          claudeCode: { authentication: "provider" },
          accounts: { kind: "key" },
        },
      }),
    );
    expect(settings.builtIns["claude-code"]?.settings).not.toHaveProperty(
      "accountLock",
    );

    // The dialog stays open on the update, so nobody has to open the runtime
    // again to bring its agents along.
    expect(
      await within(dialog).findByText(
        "2 agents on Claude Code still use older settings",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Edit Claude Code runtime" }),
    ).toBe(dialog);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // The update names the limits it brings.
    expect(
      within(dialog).getByText(
        "Updating gives them the saved limits: idle timeout, maximum duration, metered LLM budget, default tier and scaleup tier.",
      ),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Update 2 agents" }),
    );
    await waitFor(() => expect(applied).toEqual(["claude-code"]));
    expect(
      await within(dialog).findByText(
        "Every agent on Claude Code already uses these settings.",
      ),
    ).toBeInTheDocument();
    // Nothing is unsaved, so the footer's way out reads Close, beside the
    // dialog's own close button.
    expect(
      within(dialog).queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    await closeRuntime(user, dialog);
  });

  it("keeps a runtime's settings open on save: the toast confirms it, nothing is left unsaved, and Close closes it", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Actions for Claude Code" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
    const dialog = screen.getByRole("dialog", {
      name: "Edit Claude Code runtime",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Runtime settings" }),
    );
    const duration = () =>
      within(dialog).getByRole("spinbutton", { name: /Maximum duration/ });
    await user.type(duration(), "8");
    // An unsaved change: the footer's way out reads Cancel.
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    await saveRuntime(user, dialog);
    expect(settings.builtIns["claude-code"]).toMatchObject({
      settings: { ttlHours: 8 },
    });

    // Still the same settings, on the section the save was made from, with
    // what was saved. No agent is on older settings, and the block says so.
    expect(
      screen.getByRole("dialog", { name: "Edit Claude Code runtime" }),
    ).toBe(dialog);
    expect(duration()).toHaveValue(8);
    expect(
      await within(dialog).findByText(
        "Every agent on Claude Code already uses these settings.",
      ),
    ).toBeVisible();

    // The next change saves from the same open settings.
    await user.clear(duration());
    await user.type(duration(), "12");
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    await saveRuntime(user, dialog);
    expect(settings.builtIns["claude-code"]?.settings.ttlHours).toBe(12);

    await closeRuntime(user, dialog);
    expect(
      screen.getByRole("button", { name: "Actions for Claude Code" }),
    ).toBeEnabled();
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
    // Loaded, Add runtime turns into a menu of the removed runtimes.
    await saved();
    const add = screen.getByRole("button", { name: "Add runtime" });
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
    // A typed-in runtime asks before it is thrown away.
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
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
    await user.click(screen.getByRole("button", { name: "Runtime settings" }));
    await user.click(screen.getByRole("textbox", { name: "Container image" }));
    await user.paste("registry.example.com/engineering:v1");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add runtime",
      }),
    );
    // Adding it in the dialog saves it: nothing else to click.
    await waitFor(() => expect(settings.templates).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
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

  it("edits, reorders, removes and adds back entries, saving each change as it is made", async () => {
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
    const editor = screen.getByRole("dialog", {
      name: "Edit Engineering workspace runtime",
    });
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Review workspace");
    await saveRuntime(user, editor);
    expect(settings.templates[0].name).toBe("Review workspace");
    // The open settings carry the saved name.
    expect(editor).toHaveAccessibleName("Edit Review workspace runtime");
    await closeRuntime(user, editor);
    await user.click(screen.getByRole("button", { name: "Actions for Codex" }));
    expect(
      screen.getByRole("menuitem", { name: "Edit runtime" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from list" }),
    );
    expect(
      screen.queryByRole("button", { name: "Actions for Codex" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(overrides?.codex?.hidden).toBe(true));
    await saved();
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
    await saved();
    const add = screen.getByRole("button", { name: "Add runtime" });
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
    await waitFor(() => expect(settings.templates[0].hidden).toBe(false));
    await saved();
    const rows = within(
      screen.getByRole("list", { name: "Available runtimes" }),
    ).getAllByRole("listitem");
    expect(rows.at(-2)).toHaveTextContent("Codex");
    expect(rows.at(-1)).toHaveTextContent("Review workspace");
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
    await saved();
    const add = screen.getByRole("button", { name: "Add runtime" });
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
    // Not a runtime, so it is nothing to restore: Create custom runtime still
    // goes straight to the custom runtime form.
    await user.click(
      screen.getByRole("button", { name: "Create custom runtime" }),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Add custom runtime" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
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

  it("names the button Create custom runtime and opens the form directly while nothing is removed", async () => {
    mount();
    const user = userEvent.setup();
    const create = await screen.findByRole("button", {
      name: "Create custom runtime",
    });
    await waitFor(() => expect(create).toBeEnabled());
    expect(
      screen.queryByRole("button", { name: "Add runtime" }),
    ).not.toBeInTheDocument();
    await user.click(create);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Add custom runtime" }),
    ).toBeInTheDocument();
  });

  it("offers removed runtimes from Add runtime, and returns to Create custom runtime once the last is restored", async () => {
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
    await saved();
    await user.click(screen.getByRole("button", { name: "Add runtime" }));
    expect(
      screen.getByRole("menuitem", { name: "Create custom runtime…" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Codex/ }));
    await waitFor(() => expect(overrides?.codex?.hidden).toBe(false));
    await saved();
    expect(
      screen.queryByRole("button", { name: "Add runtime" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Create custom runtime" }),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Add custom runtime" }),
    ).toBeInTheDocument();
  });

  it("does not add a custom runtime past the limit of 100", async () => {
    settings.templates = Array.from({ length: 100 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Workspace ${index}`,
      description: "",
      icon: null,
      hidden: false,
      position: index,
      runtime: {
        ...buildCustomAgentRuntime({ image: "registry.example.com/dev:v1" }),
        privileged: false as const,
      },
    }));
    mount();
    expect(
      await screen.findByRole("button", { name: "Actions for Workspace 99" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Create custom runtime" }),
    ).toBeDisabled();
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
    const create = await screen.findByRole("button", {
      name: "Create custom runtime",
    });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "New workspace",
    );
    await user.click(screen.getByRole("button", { name: "Runtime settings" }));
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

describe("the accounts a custom runtime gives its agents", () => {
  const customTemplate = (
    runtime: Partial<Settings["templates"][number]["runtime"]>,
  ): Settings["templates"][number] => ({
    id: "00000000-0000-4000-8000-000000000002",
    name: "Claude workspace",
    description: "",
    icon: null,
    hidden: false,
    position: 0,
    runtime: {
      ...buildCustomAgentRuntime({ image: "registry.example.com/claude:v1" }),
      privileged: false,
      ...runtime,
    },
  });
  const openRuntimeSettings = async (
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    await user.click(
      await screen.findByRole("button", {
        name: "Actions for Claude workspace",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
    const dialog = screen.getByRole("dialog", {
      name: "Edit Claude workspace runtime",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Runtime settings" }),
    );
    return dialog;
  };
  const save = saveRuntime;

  it("follow what the runtime runs: one company card on another protocol, the two Claude cards on Anthropic's", async () => {
    settings.templates = [customTemplate({})];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    // A runtime with one account shows it as always on: nothing to tick.
    expect(
      within(dialog).getByRole("heading", { name: "Credentials to use" }),
    ).toBeVisible();
    expect(
      within(accountsGroup(dialog)).getByText("Provider API key"),
    ).toBeVisible();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByText(/Each person's/)).toBeNull();

    await user.click(
      within(dialog).getByRole("combobox", { name: "Inference API" }),
    );
    await user.click(
      screen.getByRole("option", { name: /Anthropic Messages/ }),
    );
    // A custom image names no account until an administrator picks one, so
    // both are ticked. The subscription says what the image must do.
    expect(subscriptionCard(dialog)).toBeChecked();
    expect(companyCard(dialog)).toBeChecked();
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    expect(
      within(accountsGroup(dialog)).getByText(
        /Choose a personal subscription only for an image that runs Claude Code/,
      ),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("combobox", { name: "Inference API" }),
    );
    await user.click(screen.getByRole("option", { name: /OpenAI Responses/ }));
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await save(user, dialog);
    await waitFor(() =>
      expect(settings.templates[0].runtime.inferenceProtocol).toBe(
        "openai_responses",
      ),
    );
    expect(settings.templates[0].runtime).not.toHaveProperty("claudeCode");
    expect(settings.templates[0]).not.toHaveProperty("accounts");
  });

  it("show a runtime that stores a Claude account and no rule as both, and write nothing about the accounts on an unrelated save", async () => {
    // What a runtime saved before its settings had a rule holds: a Claude
    // account, here with a model, and no `accounts`.
    settings.templates = [
      customTemplate({
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "provider", model: "opus" },
      }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    // Only the rule's kind unticks a card.
    expect(subscriptionCard(dialog)).toBeChecked();
    expect(companyCard(dialog)).toBeChecked();
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    // The maintained command needs no word on what a custom image must do.
    expect(
      within(dialog).queryByText(/Choose a personal subscription only for/),
    ).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "General" }));
    await user.type(
      within(dialog).getByRole("textbox", { name: "Description" }),
      "Reviews",
    );
    await save(user, dialog);
    await waitFor(() =>
      expect(settings.templates[0].description).toBe("Reviews"),
    );
    expect(settings.templates[0]).not.toHaveProperty("accounts");
    expect(settings.templates[0].runtime.claudeCode).toEqual({
      authentication: "provider",
      model: "opus",
    });
  });

  it("write the kind into the rule once one card is left on such a runtime, with its Claude account on that kind, keeping its model", async () => {
    settings.templates = [
      customTemplate({
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "subscription", model: "opus" },
      }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    // The line under the heading follows the cards.
    await user.click(subscriptionCard(dialog));
    expect(within(dialog).getByText("Locked to an API key")).toBeVisible();
    await save(user, dialog);
    await waitFor(() => expect(templateAccounts()).toEqual({ kind: "key" }));
    // The runtime's Claude account follows the kind the rule names.
    expect(settings.templates[0].runtime.claudeCode).toEqual({
      authentication: "provider",
      model: "opus",
    });
    expect(settings.templates[0].runtime).not.toHaveProperty("accountLock");
  });

  it.for([
    { command: ["archestra-claude-code"] },
    { command: ["my-agent"] },
  ] as const)("show a runtime saved with no account as both, and leave it so on an unrelated save ($command)", async ({
    command,
  }) => {
    settings.templates = [
      customTemplate({ command: [...command], inferenceProtocol: "anthropic" }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    expect(subscriptionCard(dialog)).toBeChecked();
    expect(companyCard(dialog)).toBeChecked();
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "General" }));
    await user.type(
      within(dialog).getByRole("textbox", { name: "Description" }),
      "Reviews",
    );
    await save(user, dialog);
    await waitFor(() =>
      expect(settings.templates[0].description).toBe("Reviews"),
    );
    expect(settings.templates[0].runtime).not.toHaveProperty("claudeCode");
    expect(settings.templates[0].runtime).not.toHaveProperty("accountLock");
    expect(settings.templates[0]).not.toHaveProperty("accounts");
  });

  it("write no kind once both are selected again, and leave the runtime's Claude account as it was", async () => {
    settings.templates = [
      {
        ...customTemplate({
          command: ["my-agent"],
          inferenceProtocol: "anthropic",
          claudeCode: { authentication: "provider" },
        }),
        accounts: { kind: "key" },
      },
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    expect(companyCard(dialog)).toBeChecked();
    expect(subscriptionCard(dialog)).not.toBeChecked();
    await user.click(subscriptionCard(dialog));
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    await save(user, dialog);
    await waitFor(() =>
      expect(settings.templates[0]).not.toHaveProperty("accounts"),
    );
    // It still declares that the image runs Claude Code, and is where a new
    // agent starts.
    expect(settings.templates[0].runtime.claudeCode).toEqual({
      authentication: "provider",
    });
    expect(settings.templates[0].runtime).not.toHaveProperty("accountLock");
  });

  it("puts the Claude account back as it was last saved, not as the settings were opened, once both are selected again after a save", async () => {
    // Opened on subscriptions, with no rule.
    settings.templates = [
      customTemplate({
        command: ["my-agent"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "subscription", model: "opus" },
      }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    await user.click(subscriptionCard(dialog));
    await save(user, dialog);
    expect(templateAccounts()).toEqual({ kind: "key" });
    expect(settings.templates[0].runtime.claudeCode).toEqual({
      authentication: "provider",
      model: "opus",
    });

    // The settings stayed open. Both selected again writes no kind, and
    // leaves the Claude account as that save stored it: what opening the
    // runtime again would start from.
    await user.click(subscriptionCard(dialog));
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    await save(user, dialog);
    expect(settings.templates[0]).not.toHaveProperty("accounts");
    expect(settings.templates[0].runtime.claudeCode).toEqual({
      authentication: "provider",
      model: "opus",
    });
  });

  it.for([
    {
      keep: "subscription" as const,
      untick: companyCard,
      meaning: "Locked to each user's personal subscription",
    },
    {
      keep: "provider" as const,
      untick: subscriptionCard,
      meaning: "Locked to an API key",
    },
  ])("save $keep for a custom image once the other card is unticked", async ({
    keep,
    untick,
    meaning,
  }) => {
    settings.templates = [
      customTemplate({ command: ["my-agent"], inferenceProtocol: "anthropic" }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    await user.click(untick(dialog));
    expect(within(dialog).getByText(meaning)).toBeVisible();
    await save(user, dialog);
    await waitFor(() =>
      expect(settings.templates[0].runtime.claudeCode).toEqual({
        authentication: keep,
      }),
    );
    expect(templateAccounts()).toEqual({
      kind: keep === "provider" ? "key" : "subscription",
    });
  });

  it("cannot be saved with no account selected", async () => {
    settings.templates = [
      customTemplate({
        command: ["my-agent"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "provider" },
      }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openRuntimeSettings(user);
    await user.click(companyCard(dialog));
    await user.click(subscriptionCard(dialog));
    expect(companyCard(dialog)).not.toBeChecked();
    expect(subscriptionCard(dialog)).not.toBeChecked();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Select at least one option.",
    );
    expect(
      within(dialog).getByText(
        "Selecting more than one option allows users to choose.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    ).toBeDisabled();

    // Selecting one again clears it.
    await user.click(subscriptionCard(dialog));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await save(user, dialog);
    await waitFor(() =>
      expect(settings.templates[0].runtime.claudeCode).toEqual({
        authentication: "subscription",
      }),
    );
    expect(templateAccounts()).toEqual({ kind: "subscription" });
  });
});

describe("the accounts the built-in Claude Code runtime gives its agents", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      await screen.findByRole("button", { name: "Actions for Claude Code" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
    const dialog = screen.getByRole("dialog", {
      name: "Edit Claude Code runtime",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Runtime settings" }),
    );
    return dialog;
  };
  const save = saveRuntime;
  /** The maintained runtime's settings, as the list was last saved. */
  const stored = () => settings.builtIns["claude-code"]?.settings;

  it("names no account with nothing stored, and writes neither a kind nor a Claude account while both are selected", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(subscriptionCard(dialog)).toBeChecked();
    expect(companyCard(dialog)).toBeChecked();
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    // The company card's connection is optional: left empty, each agent
    // picks its own.
    expect(within(dialog).getByRole("button", NOTHING_FIXED)).toBeVisible();
    await user.type(
      within(dialog).getByRole("spinbutton", { name: /Maximum duration/ }),
      "8",
    );
    await save(user, dialog);
    await waitFor(() => expect(stored()?.ttlHours).toBe(8));
    expect(stored()).not.toHaveProperty("accounts");
    expect(stored()).not.toHaveProperty("claudeCode");
    expect(stored()).not.toHaveProperty("accountLock");
  });

  it.for([
    {
      untick: companyCard,
      kind: "subscription" as const,
      authentication: "subscription" as const,
      meaning: "Locked to each user's personal subscription",
    },
    {
      untick: subscriptionCard,
      kind: "key" as const,
      authentication: "provider" as const,
      meaning: "Locked to an API key",
    },
  ])("writes the kind $kind into the rule once one card is left, with the Claude account of that kind", async ({
    untick,
    kind,
    authentication,
    meaning,
  }) => {
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.click(untick(dialog));
    expect(within(dialog).getByText(meaning)).toBeVisible();
    await save(user, dialog);
    await waitFor(() => expect(stored()?.accounts).toEqual({ kind }));
    expect(stored()?.claudeCode).toEqual({ authentication });
  });

  it("shows a runtime that stores a Claude account and no rule as both, and writes nothing about the accounts on an unrelated save", async () => {
    // What every save of this runtime's settings once wrote: a Claude
    // account, and no `accounts`.
    settings.builtIns = {
      "claude-code": {
        settings: { claudeCode: { authentication: "provider" } },
      },
    };
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    // Only the rule's kind unticks a card.
    expect(subscriptionCard(dialog)).toBeChecked();
    expect(companyCard(dialog)).toBeChecked();
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    // Nothing was changed yet: the runtime is as it was saved.
    expect(
      within(dialog).queryByText(/Updates use the saved settings/),
    ).toBeNull();
    await user.type(
      within(dialog).getByRole("spinbutton", { name: /Maximum duration/ }),
      "8",
    );
    await save(user, dialog);
    await waitFor(() => expect(stored()?.ttlHours).toBe(8));
    expect(stored()).not.toHaveProperty("accounts");
    expect(stored()?.claudeCode).toEqual({ authentication: "provider" });

    // One card left writes the kind into the rule, and puts the runtime's
    // Claude account on it. The settings are still open on what was saved.
    await user.click(companyCard(dialog));
    expect(
      within(dialog).getByText("Locked to each user's personal subscription"),
    ).toBeVisible();
    await save(user, dialog);
    await waitFor(() =>
      expect(stored()?.accounts).toEqual({ kind: "subscription" }),
    );
    expect(stored()?.claudeCode).toEqual({ authentication: "subscription" });

    // Both selected again takes the rule's kind away, and leaves the Claude
    // account as it was last stored.
    expect(companyCard(dialog)).not.toBeChecked();
    await user.click(companyCard(dialog));
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    await save(user, dialog);
    await waitFor(() => expect(stored()).not.toHaveProperty("accounts"));
    expect(stored()?.claudeCode).toEqual({ authentication: "subscription" });
  });

  it("cannot be saved with no account selected", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    await user.click(subscriptionCard(dialog));
    await user.click(companyCard(dialog));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Select at least one option.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    ).toBeDisabled();
    await user.click(companyCard(dialog));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    ).toBeEnabled();
  });
});

describe("a link that names a runtime", () => {
  /** The footer's button: nothing was changed, so it reads Close. */
  const closeButton = (dialog: HTMLElement) =>
    within(dialog)
      .getAllByRole("button", { name: "Close" })
      .at(-1) as HTMLElement;
  const team: Settings["templates"][number] = {
    id: "00000000-0000-4000-8000-000000000004",
    name: "Team workspace",
    description: "",
    icon: null,
    hidden: false,
    position: 0,
    runtime: {
      ...buildCustomAgentRuntime({ image: "registry.example.com/agent:v1" }),
      privileged: false,
    },
  };

  it("opens a maintained runtime's editor on load, and takes the name out of the URL when it closes", async () => {
    navigation.search = "edit=codex";
    mount();
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", {
      name: "Edit Codex runtime",
    });
    await user.click(closeButton(dialog));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(navigation.replace).toHaveBeenCalledWith(
      "/settings/agents/runtimes",
      { scroll: false },
    );
    // Closed stays closed, also while the URL still carries the name.
    await saved();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a custom runtime's editor by its id, and keeps what else the URL carries", async () => {
    settings.templates = [team];
    navigation.search = `from=agents&edit=${team.id}`;
    mount();
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", {
      name: "Edit Team workspace runtime",
    });
    await user.click(closeButton(dialog));
    expect(navigation.replace).toHaveBeenCalledWith(
      "/settings/agents/runtimes?from=agents",
      { scroll: false },
    );
  });

  it("opens nothing for an id that is none of the runtimes, or for someone who cannot change them", async () => {
    settings.templates = [team];
    navigation.search = "edit=00000000-0000-4000-8000-00000000ffff";
    const unknown = mount();
    await saved();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unknown.unmount();

    // They may read the list, and its editors are not theirs to open.
    navigation.search = "edit=codex";
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    mount();
    expect(
      await screen.findByRole("list", { name: "Available runtimes" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("leaves the URL alone when an editor opened from the list closes", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "Codex");
    await user.click(closeButton(dialog));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe("the company connection and model a runtime fixes for its agents", () => {
  const customTemplate = (extra: object = {}): Settings["templates"][number] =>
    ({
      id: "00000000-0000-4000-8000-000000000003",
      name: "Team workspace",
      description: "",
      icon: null,
      hidden: false,
      position: 0,
      runtime: {
        ...buildCustomAgentRuntime({ image: "registry.example.com/agent:v1" }),
        privileged: false,
      },
      ...extra,
    }) as Settings["templates"][number];
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      await screen.findByRole("button", { name: "Actions for Team workspace" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit runtime" }));
    const dialog = screen.getByRole("dialog", {
      name: "Edit Team workspace runtime",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Runtime settings" }),
    );
    return dialog;
  };

  it("leaves both to each agent until set, and writes nothing while they are empty", async () => {
    settings.templates = [customTemplate()];
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(within(dialog).getByRole("button", NOTHING_FIXED)).toBeVisible();
    // The model waits for a connection.
    expect(modelField(dialog)).toBeDisabled();
    expect(modelField(dialog)).toHaveAccessibleName(
      "Model Choose an API key first",
    );
    expect(within(dialog).queryByRole("button", { name: /^Clear/ })).toBeNull();

    // A custom image on an OpenAI protocol can call any provider's key.
    await user.click(connectionField(dialog));
    expect(
      await screen.findByRole("option", { name: /Company OpenAI/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /Company Anthropic/ }),
    ).toBeVisible();
    await user.keyboard("{Escape}");

    // Nothing was set, so an unrelated save writes no accounts.
    await user.click(within(dialog).getByRole("button", { name: "General" }));
    await user.type(
      within(dialog).getByRole("textbox", { name: "Description" }),
      "Reviews",
    );
    await saveRuntime(user, dialog);
    expect(settings.templates[0].description).toBe("Reviews");
    expect(settings.templates[0]).not.toHaveProperty("accounts");
  });

  it("fixes the connection alone, then its model, and clears each again", async () => {
    settings.templates = [customTemplate()];
    mount();
    const user = userEvent.setup();
    let dialog = await open(user);
    await pick(user, connectionField(dialog), /Company OpenAI/);
    expect(connectionField(dialog)).toHaveAccessibleName("Key Company OpenAI");
    expect(within(dialog).getByText(CONNECTION_FIXED)).toBeVisible();
    expect(modelField(dialog)).toBeEnabled();
    await saveRuntime(user, dialog);
    expect(templateAccounts()).toEqual({ llmApiKeyId: "key-openai" });

    // The settings stay open on the saved connection: its model is next.
    await pick(user, modelField(dialog), /GPT-5/);
    expect(modelField(dialog)).toHaveAccessibleName("Model GPT-5");
    expect(within(dialog).getByText(BOTH_FIXED)).toBeVisible();
    await saveRuntime(user, dialog);
    expect(templateAccounts()).toEqual({
      llmApiKeyId: "key-openai",
      modelId: "model-gpt",
    });

    // Opened again, the settings show what was stored. Each field has a
    // clear control of its own, reached by keyboard too.
    await closeRuntime(user, dialog);
    dialog = await open(user);
    expect(modelField(dialog)).toHaveAccessibleName("Model GPT-5");
    const clearModel = within(dialog).getByRole("button", {
      name: "Clear model",
    });
    clearModel.focus();
    await user.keyboard("{Enter}");
    expect(within(dialog).getByText(CONNECTION_FIXED)).toBeVisible();
    await saveRuntime(user, dialog);
    expect(templateAccounts()).toEqual({ llmApiKeyId: "key-openai" });

    await user.click(within(dialog).getByRole("button", { name: "Clear key" }));
    expect(within(dialog).getByRole("button", NOTHING_FIXED)).toBeVisible();
    expect(modelField(dialog)).toBeDisabled();
    await saveRuntime(user, dialog);
    expect(settings.templates[0]).not.toHaveProperty("accounts");
  });

  it("says when the fixed connection no longer exists, until another is chosen or it is cleared", async () => {
    settings.templates = [
      customTemplate({
        accounts: {
          llmApiKeyId: "key-deleted",
          keyName: "Old company key",
          keyMissing: true,
        },
      }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "This connection no longer exists. Choose another or clear it.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Clear key" }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await saveRuntime(user, dialog);
    expect(settings.templates[0]).not.toHaveProperty("accounts");
  });

  it("fixes a built-in runtime's one account on a connection", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "OpenCode");
    // One always-on card: nothing to tick, and no meaning line to follow.
    expect(
      within(accountsGroup(dialog)).getByText("Provider API key"),
    ).toBeVisible();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await pick(user, connectionField(dialog), /Company Anthropic/);
    await pick(user, modelField(dialog), /Claude Sonnet/);
    await saveRuntime(user, dialog);
    expect(builtInAccounts("opencode")).toEqual({
      llmApiKeyId: "key-anthropic",
      modelId: "model-sonnet",
    });
  });

  it("keeps a Claude runtime's connection with its company card, and drops it with the card", async () => {
    mount();
    const user = userEvent.setup();
    let dialog = await openBuiltIn(user, "Claude Code");
    // Both cards: the company card holds the connection, and no kind is
    // named.
    await pick(user, connectionField(dialog), /Company Anthropic/);
    await saveRuntime(user, dialog);
    expect(builtInAccounts("claude-code")).toEqual({
      llmApiKeyId: "key-anthropic",
    });
    expect(settings.builtIns["claude-code"]?.settings).not.toHaveProperty(
      "claudeCode",
    );

    // Subscriptions alone: there is no company card to hold a connection.
    await closeRuntime(user, dialog);
    dialog = await openBuiltIn(user, "Claude Code");
    expect(connectionField(dialog)).toHaveAccessibleName(
      "Key Company Anthropic",
    );
    await user.click(companyCard(dialog));
    expect(within(dialog).queryByRole("button", { name: /^Key/ })).toBeNull();
    await saveRuntime(user, dialog);
    expect(builtInAccounts("claude-code")).toEqual({ kind: "subscription" });
  });

  it("offers only shared connections, and names one the reader's list lacks by the name the rule gives", async () => {
    // A personal key of the administrator's own, beside the shared ones.
    keys = [
      openAiKey,
      makeLlmProviderApiKey({
        id: "key-mine",
        name: "My own OpenAI",
        provider: "openai",
        scope: "personal",
        userId: "admin",
      }),
    ];
    settings.templates = [
      customTemplate({
        accounts: {
          llmApiKeyId: "key-of-another-team",
          keyName: "Platform team OpenAI",
          keyProvider: "openai",
        },
      }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(connectionField(dialog)).toHaveAccessibleName(
      "Key Platform team OpenAI",
    );
    await user.click(connectionField(dialog));
    expect(
      await screen.findByRole("option", { name: /Company OpenAI/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /My own OpenAI/ })).toBeNull();
  });

  it("says when the fixed model no longer exists, until another is chosen or it is cleared", async () => {
    settings.templates = [
      customTemplate({
        accounts: {
          llmApiKeyId: "key-openai",
          keyName: "Company OpenAI",
          modelId: "model-deleted",
          modelMissing: true,
        },
      }),
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await open(user);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "This model no longer exists. Choose another or clear it.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Clear model" }),
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await saveRuntime(user, dialog);
    expect(templateAccounts()).toEqual({ llmApiKeyId: "key-openai" });
  });
});

describe("the kind of account a runtime with a subscription of its own names", () => {
  const chatGptCard = (dialog: HTMLElement) =>
    within(dialog).getByRole("checkbox", {
      name: /Each person's ChatGPT subscription/,
    });

  it("writes each state of Codex's two cards, with its connection limited to OpenAI", async () => {
    mount();
    const user = userEvent.setup();
    let dialog = await openBuiltIn(user, "Codex");
    // Named by neither card until an administrator chooses.
    expect(chatGptCard(dialog)).toBeChecked();
    expect(companyCard(dialog)).toBeChecked();
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    await user.click(connectionField(dialog));
    expect(
      await screen.findByRole("option", { name: /Company OpenAI/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Company xAI/ })).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(chatGptCard(dialog));
    expect(within(dialog).getByText("Locked to an API key")).toBeVisible();
    await pick(user, connectionField(dialog), /Company OpenAI/);
    await saveRuntime(user, dialog);
    expect(builtInAccounts("codex")).toEqual({
      kind: "key",
      llmApiKeyId: "key-openai",
    });

    // Subscriptions alone hold no connection.
    await closeRuntime(user, dialog);
    dialog = await openBuiltIn(user, "Codex");
    expect(chatGptCard(dialog)).not.toBeChecked();
    await user.click(chatGptCard(dialog));
    await user.click(companyCard(dialog));
    expect(
      within(dialog).getByText("Locked to each user's personal subscription"),
    ).toBeVisible();
    await saveRuntime(user, dialog);
    expect(builtInAccounts("codex")).toEqual({ kind: "subscription" });

    // Both again leaves everything to each agent: nothing is stored. The
    // settings are still open on the subscriptions just saved.
    expect(companyCard(dialog)).not.toBeChecked();
    await user.click(companyCard(dialog));
    expect(within(dialog).getByText(BOTH)).toBeVisible();
    await saveRuntime(user, dialog);
    expect(builtInAccounts("codex")).toBeUndefined();
  });

  it("cannot save Codex with neither card selected", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "Codex");
    await user.click(chatGptCard(dialog));
    await user.click(companyCard(dialog));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Select at least one option.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    ).toBeDisabled();
    await user.click(chatGptCard(dialog));
    expect(
      within(dialog).getByRole("button", { name: "Save runtime" }),
    ).toBeEnabled();
  });

  it("writes Grok Build's company key with its xAI connection and model", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "Grok Build");
    const superGrok = within(dialog).getByRole("checkbox", {
      name: /Each person's SuperGrok subscription/,
    });
    expect(superGrok).toBeChecked();
    await user.click(superGrok);
    await user.click(connectionField(dialog));
    expect(
      await screen.findByRole("option", { name: /Company xAI/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Company OpenAI/ })).toBeNull();
    await user.click(screen.getByRole("option", { name: /Company xAI/ }));
    await pick(user, modelField(dialog), /Grok 4/);
    await saveRuntime(user, dialog);
    expect(builtInAccounts("grok")).toEqual({
      kind: "key",
      llmApiKeyId: "key-xai",
      modelId: "model-grok",
    });
  });

  it("shows the Copilot CLI's subscription beside its enterprise plan, and fixes the plan's model", async () => {
    keys = [...keys, copilotPlan];
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "GitHub Copilot CLI");
    const personal = within(dialog).getByRole("checkbox", {
      name: /Each person's GitHub Copilot subscription/,
    });
    const plan = await within(dialog).findByRole("checkbox", {
      name: /Enterprise plan: GitHub Copilot Example Org/,
    });
    expect(personal).toBeChecked();
    expect(plan).toBeChecked();
    expect(
      within(dialog).getByText(
        "People who create or edit an agent on this runtime choose whether it allows personal subscriptions, the company's enterprise plan, or both.",
      ),
    ).toBeVisible();
    // The plan is the connection: only its model is picked.
    expect(within(dialog).queryByRole("button", { name: /^Key/ })).toBeNull();
    expect(
      within(dialog).getByText(
        "Optional. Leave the model empty to set it in each agent's settings.",
      ),
    ).toBeVisible();

    await user.click(personal);
    expect(
      within(dialog).getByText("Locked to the company's enterprise plan"),
    ).toBeVisible();
    await pick(user, modelField(dialog), /Copilot GPT-5/);
    expect(
      within(dialog).getByText("Every agent on this runtime uses this model."),
    ).toBeVisible();
    await saveRuntime(user, dialog);
    expect(builtInAccounts("copilot")).toEqual({
      kind: "key",
      llmApiKeyId: "plan-1",
      modelId: "model-copilot",
    });
  });

  it("holds a model for each enterprise plan while several are left to each agent, and keeps a plan's model with it", async () => {
    keys = [
      ...keys,
      copilotPlan,
      { ...copilotPlan, id: "plan-2", githubOrganizationName: "Second Org" },
    ];
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "GitHub Copilot CLI");
    const planCard = (organization: string) =>
      within(dialog)
        .getByRole("checkbox", {
          name: new RegExp(`Enterprise plan: GitHub Copilot ${organization}`),
        })
        .closest("label")?.parentElement as HTMLElement;
    const modelOf = (organization: string) =>
      within(planCard(organization)).getByRole("button", { name: /^Model/ });

    // Every card is ticked: each plan holds the model set for it.
    for (const organization of ["Example Org", "Second Org"]) {
      expect(
        within(planCard(organization)).getByText(
          "Optional. Leave the model empty to set it in each agent's settings.",
        ),
      ).toBeVisible();
    }
    await pick(user, modelOf("Second Org"), /Copilot GPT-5/);
    expect(
      within(planCard("Second Org")).getByText(
        "Every agent on this runtime uses this model on this plan.",
      ),
    ).toBeVisible();
    await saveRuntime(user, dialog);
    expect(builtInAccounts("copilot")).toEqual({
      connectionModels: { "plan-2": "model-copilot" },
    });

    // Unticking the other plan fixes this one, with the model set for it.
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Enterprise plan: GitHub Copilot Example Org/,
      }),
    );
    await saveRuntime(user, dialog);
    expect(builtInAccounts("copilot")).toEqual({
      llmApiKeyId: "plan-2",
      modelId: "model-copilot",
    });
  });

  it("says when the enterprise plan the Copilot CLI fixed no longer exists, until another is chosen", async () => {
    // Two plans: unticking one settles the runtime on the other.
    keys = [
      ...keys,
      copilotPlan,
      { ...copilotPlan, id: "plan-2", githubOrganizationName: "Second Org" },
    ];
    settings.builtIns = {
      copilot: {
        settings: {
          accounts: { kind: "key", llmApiKeyId: "plan-gone", keyMissing: true },
        },
      },
    } as Settings["builtIns"];
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "GitHub Copilot CLI");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The enterprise plan this runtime fixed no longer exists. Choose another.",
    );
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Enterprise plan: GitHub Copilot Second Org/,
      }),
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await saveRuntime(user, dialog);
    expect(builtInAccounts("copilot")).toEqual({
      kind: "key",
      llmApiKeyId: "plan-1",
    });
  });

  it("shows the Copilot CLI's subscription as its one account while no enterprise plan is connected", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "GitHub Copilot CLI");
    expect(
      within(accountsGroup(dialog)).getByText(
        "Each person's GitHub Copilot subscription",
      ),
    ).toBeVisible();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByText(/Enterprise plan/)).toBeNull();
    await user.type(
      within(dialog).getByRole("spinbutton", { name: /Maximum duration/ }),
      "8",
    );
    await saveRuntime(user, dialog);
    expect(builtInAccounts("copilot")).toBeUndefined();
  });

  it("keeps the card of the enterprise plan the Copilot CLI fixed once no plan is left, so it can be unticked", async () => {
    // The plan was deleted, and no other is connected.
    settings.builtIns = {
      copilot: {
        settings: {
          accounts: { kind: "key", llmApiKeyId: "plan-gone", keyMissing: true },
        },
      },
    } as Settings["builtIns"];
    mount();
    const user = userEvent.setup();
    const dialog = await openBuiltIn(user, "GitHub Copilot CLI");
    const plan = await within(dialog).findByRole("checkbox", {
      name: /^Enterprise plan/,
    });
    const personal = within(dialog).getByRole("checkbox", {
      name: /Each person's GitHub Copilot subscription/,
    });
    expect(plan).toBeChecked();
    expect(personal).not.toBeChecked();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The enterprise plan this runtime uses no longer exists. Untick it.",
    );

    await user.click(personal);
    await user.click(plan);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await saveRuntime(user, dialog);
    expect(builtInAccounts("copilot")).toEqual({ kind: "subscription" });
  });
});
