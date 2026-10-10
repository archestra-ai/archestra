import { archestraApiClient, PopularAgentIdSchema } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";
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
import {
  AGENT_CATALOG_TEMPLATE_NAMES,
  AgentCatalog,
} from "@/components/agent-pages/agent-catalog";
import {
  type AgentRuntimeConfig,
  defaultAgentRuntime,
} from "@/components/agent-runtime-fields";
import {
  AgentRuntimePicker,
  type AgentRuntimeSelection,
} from "@/components/agent-runtime-picker";
import {
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { organizationKeys } from "@/lib/organization.query";
import { makeOrganization } from "@/mocks/data/organization";
import { IntegrationAvailabilitySection } from "./integration-availability-section";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("sonner");

const origin = "http://localhost:9000";
const server = setupServer();
let organization = makeOrganization();
let writes: unknown[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  organization = makeOrganization();
  writes = [];
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "test-user" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue({});
  vi.mocked(useFeature).mockReturnValue(undefined);
  vi.mocked(useAppName).mockReturnValue("Test Platform");
  vi.mocked(useAppIconLogo).mockReturnValue("/logo-icon.svg");
  server.use(
    http.get(`${origin}/api/organization`, () =>
      HttpResponse.json(organization),
    ),
    http.patch(
      `${origin}/api/organization/integration-settings`,
      async ({ request }) => {
        const payload = (await request.json()) as Partial<typeof organization>;
        writes.push(payload);
        organization = { ...organization, ...payload };
        return HttpResponse.json(organization);
      },
    ),
  );
});

function renderFlow({
  cached = false,
  runtimeId = "chat",
}: {
  cached?: boolean;
  runtimeId?: AgentRuntimeSelection;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (cached)
    queryClient.setQueryData(organizationKeys.details(), organization);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntegrationAvailabilitySection
        catalogKey="popularAgentOverrides"
        catalog={PopularAgentIdSchema.options}
        title="Popular agent settings"
        options={PopularAgentIdSchema.options.map((id) => ({
          value: id,
          label: AGENT_CATALOG_TEMPLATE_NAMES[id],
        }))}
        placeholder="Select popular agents…"
        emptyMessage="No agents found."
        savedMessage="Popular agents updated"
      />
      <AgentCatalog
        canAddExternalAgent
        canCreateAgent
        runtimeAvailable
        onStartFromScratch={vi.fn()}
        onAddExternalAgent={vi.fn()}
        onSelect={vi.fn()}
      />
      <RuntimeFlow initialId={runtimeId} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function RuntimeFlow({ initialId }: { initialId: AgentRuntimeSelection }) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [runtime, setRuntime] = useState<AgentRuntimeConfig | null>(
    initialId === "chat"
      ? null
      : {
          ...defaultAgentRuntime(),
          image: "registry.example.com/existing:1",
          command: ["archestra-codex"],
          environment: [{ key: "KEEP_SETTING", value: "kept" }],
        },
  );
  return (
    <>
      <AgentRuntimePicker
        selectedId={selectedId}
        value={runtime}
        onSelect={(id, next) => {
          setSelectedId(id);
          setRuntime(next);
        }}
        onChange={setRuntime}
        modelBlock={<div>Model settings</div>}
        modelSummary="Model settings"
      />
      <output data-testid="runtime-state">{JSON.stringify(runtime)}</output>
    </>
  );
}

async function remove(name: string) {
  await userEvent.click(screen.getByRole("button", { name: `Remove ${name}` }));
}

function picker() {
  return within(screen.getByRole("list", { name: "Coding agents" }));
}

function savedOverrides(ids: string[]) {
  return Object.fromEntries(
    PopularAgentIdSchema.options.map((id) => [
      id,
      ids.includes(id) ? { position: ids.indexOf(id) } : { hidden: true },
    ]),
  );
}

async function ready() {
  await screen.findByRole("heading", { name: "Coding agents" });
}

describe("popular agent configuration", () => {
  it("withholds cached templates during a fresh read and offers retry after a refresh failure", async () => {
    const responseReady = Promise.withResolvers<void>();
    server.use(
      http.get(
        `${origin}/api/organization`,
        async () => {
          await responseReady.promise;
          return HttpResponse.json(
            { error: { message: "Unavailable" } },
            { status: 500 },
          );
        },
        { once: true },
      ),
    );
    renderFlow({ cached: true });
    try {
      expect(
        screen.queryByRole("button", { name: /Codex / }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /New Test Platform agent/ }),
      ).toBeInTheDocument();
    } finally {
      responseReady.resolve();
    }
    await waitFor(() =>
      expect(screen.getAllByText("Could not load coding agents")).toHaveLength(
        2,
      ),
    );
    expect(
      screen.queryByRole("button", { name: /Codex / }),
    ).not.toBeInTheDocument();
    organization.popularAgentOverrides = { codex: { hidden: true } };
    await userEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    await screen.findByRole("button", { name: /Claude Code / });
    expect(
      screen.queryByRole("button", { name: /Codex / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Codex" }),
    ).not.toBeInTheDocument();
  });

  it("waits for saved overrides before allowing edits", async () => {
    organization.popularAgentOverrides = { codex: { hidden: true } };
    const responseReady = Promise.withResolvers<void>();
    server.use(
      http.get(`${origin}/api/organization`, async () => {
        await responseReady.promise;
        return HttpResponse.json(organization);
      }),
    );
    renderFlow();
    try {
      for (const button of screen.getAllByRole("button", {
        name: /^Remove /,
      })) {
        expect(button).toBeDisabled();
      }
      await remove("Claude Code");
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Coding agents" }),
      ).not.toBeInTheDocument();
      expect(writes).toEqual([]);
    } finally {
      responseReady.resolve();
    }
    await ready();
    await waitFor(() =>
      expect(picker().queryByText("Codex")).not.toBeInTheDocument(),
    );
    await remove("Claude Code");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          popularAgentOverrides: savedOverrides([
            "opencode",
            "hermes",
            "openclaw",
          ]),
        },
      ]),
    );
  });

  it("shows a retry for failed organization reads and applies saved choices on recovery", async () => {
    organization.popularAgentOverrides = { codex: { hidden: true } };
    server.use(
      http.get(
        `${origin}/api/organization`,
        () =>
          HttpResponse.json(
            { error: { message: "Unavailable" } },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    renderFlow();
    await waitFor(() =>
      expect(screen.getAllByText("Could not load coding agents")).toHaveLength(
        2,
      ),
    );
    expect(
      screen.getByText("Could not load available options"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Codex / }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    await screen.findByRole("button", { name: /Claude Code / });
    expect(screen.queryAllByText("Could not load coding agents")).toHaveLength(
      0,
    );
    expect(
      screen.queryByRole("button", { name: /Codex / }),
    ).not.toBeInTheDocument();
  });

  it("keeps all templates by default, discards drafts, and saves choices to the catalog", async () => {
    renderFlow();
    await ready();
    for (const name of Object.values(AGENT_CATALOG_TEMPLATE_NAMES)) {
      expect(
        screen.getByRole("button", { name: new RegExp(`${name} `) }),
      ).toBeInTheDocument();
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    await remove("Codex");
    expect(screen.getByRole("button", { name: /Codex / })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(picker().getByText("Codex")).toBeInTheDocument();
    expect(writes).toEqual([]);
    await remove("Codex");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Codex / }),
      ).not.toBeInTheDocument(),
    );
    expect(writes).toEqual([
      {
        popularAgentOverrides: savedOverrides([
          "claude-code",
          "opencode",
          "hermes",
          "openclaw",
        ]),
      },
    ]);
    expect(
      screen.getByRole("button", { name: /Claude Code / }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Codex" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Claude Code" }),
    ).toBeInTheDocument();
  });

  it("loads saved choices, hides an empty section, and can restore a template", async () => {
    organization.popularAgentOverrides = Object.fromEntries(
      PopularAgentIdSchema.options.map((id) => [id, { hidden: true }]),
    );
    renderFlow();
    const input = await screen.findByRole("combobox", { name: "Add an agent" });
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2));
    expect(
      screen.getByRole("radio", { name: "Test Platform" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Custom image" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Coding agents" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New Test Platform agent/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Connect via A2A/ }),
    ).toBeInTheDocument();
    await userEvent.click(input);
    await userEvent.click(screen.getByRole("option", { name: "Codex" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await ready();
    expect(screen.getByRole("button", { name: /Codex / })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Hermes / }),
    ).not.toBeInTheDocument();
    expect(organization.popularAgentOverrides?.codex).toEqual({ position: 0 });
    expect(screen.getByRole("radio", { name: "Codex" })).toBeInTheDocument();
  });

  it("keeps a hidden existing runtime as a custom image without replacing its configuration", async () => {
    organization.popularAgentOverrides = { codex: { hidden: true } };
    renderFlow({ runtimeId: "codex" });
    await ready();
    expect(
      screen.queryByRole("radio", { name: "Codex" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Custom image" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /^Image/ }));
    expect(screen.getByLabelText("Container image")).toHaveValue(
      "registry.example.com/existing:1",
    );
    expect(
      JSON.parse(screen.getByTestId("runtime-state").textContent ?? "null"),
    ).toMatchObject({
      image: "registry.example.com/existing:1",
      command: ["archestra-codex"],
      environment: [{ key: "KEEP_SETTING", value: "kept" }],
    });
    expect(writes).toEqual([]);
  });
  it("preserves unsaved selections during a refresh and cancels to the latest saved choices", async () => {
    const { queryClient } = renderFlow();
    await ready();
    await remove("Codex");
    organization = {
      ...organization,
      popularAgentOverrides: { hermes: { hidden: true } },
    };
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationKeys.details(),
      });
    });
    const selected = picker();
    expect(selected.queryByText("Codex")).not.toBeInTheDocument();
    expect(selected.getByText("Hermes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(selected.getByText("Codex")).toBeInTheDocument();
    expect(selected.queryByText("Hermes")).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it("appends a restored choice and saves the resulting order", async () => {
    renderFlow();
    await ready();
    await remove("Codex");
    await userEvent.click(
      screen.getByRole("combobox", { name: "Add an agent" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Codex" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          popularAgentOverrides: savedOverrides([
            "claude-code",
            "opencode",
            "hermes",
            "openclaw",
            "codex",
          ]),
        },
      ]),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("radio")
          .map((radio) => radio.closest("label")?.textContent),
      ).toEqual([
        "Test Platform",
        "Claude Code",
        "OpenCode",
        "Hermes",
        "OpenClaw",
        "Codex",
        "Custom image",
      ]),
    );
  });

  it("cancels a reorder, then saves and reloads it in the catalog and runtime picker", async () => {
    const view = renderFlow();
    await ready();
    const reorder = async () => {
      screen.getByRole("button", { name: "Reorder Codex" }).focus();
      await userEvent.keyboard("{ArrowLeft}");
    };
    await reorder();
    expect(picker().getAllByRole("listitem")[0]).toHaveTextContent("Codex");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(picker().getAllByRole("listitem")[0]).toHaveTextContent(
      "Claude Code",
    );
    expect(writes).toEqual([]);
    await reorder();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          popularAgentOverrides: savedOverrides([
            "codex",
            "claude-code",
            "opencode",
            "hermes",
            "openclaw",
          ]),
        },
      ]),
    );
    view.unmount();
    renderFlow();
    await ready();
    expect(picker().getAllByRole("listitem")[0]).toHaveTextContent("Codex");
    const section = screen
      .getByRole("heading", { name: "Coding agents" })
      .closest("section");
    if (!section) throw new Error("Missing catalog section");
    expect(within(section).getAllByRole("button")[0]).toHaveTextContent(
      "Codex",
    );
    expect(screen.getAllByRole("radio")[1]).toHaveAccessibleName("Codex");
  });

  it("keeps the saved catalog and draft when a save fails", async () => {
    server.use(
      http.patch(`${origin}/api/organization/integration-settings`, () =>
        HttpResponse.json(
          { error: { message: "Save failed" } },
          { status: 500 },
        ),
      ),
    );
    renderFlow();
    await ready();
    await remove("Codex");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: /Codex / })).toBeInTheDocument();
    expect(picker().queryByText("Codex")).not.toBeInTheDocument();
  });

  it("prevents users without settings permission from removing chips", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    renderFlow();
    await ready();
    for (const button of screen.getAllByRole("button", {
      name: /^Remove /,
    }))
      expect(button).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "All agents added" }),
    ).toBeDisabled();
    expect(writes).toEqual([]);
  });
});
