import { archestraApiClient, getAgentCatalogImages } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { type ReactNode, useState } from "react";
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
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { makeOrganization } from "@/mocks/data/organization";
import {
  AgentCatalog,
  getAgentCatalogTemplates,
} from "./agent-pages/agent-catalog";
import {
  type AgentRuntimeConfig,
  defaultAgentRuntime,
} from "./agent-runtime-fields";
import {
  AgentRuntimePicker,
  type AgentRuntimeSelection,
} from "./agent-runtime-picker";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/auth/auth.query");
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;
const server = setupServer(
  http.get("http://localhost:9000/api/agent-runtime-templates", () =>
    HttpResponse.json([]),
  ),
  http.get("http://localhost:9000/api/organization", () =>
    HttpResponse.json(makeOrganization()),
  ),
  http.get("http://localhost:9000/api/credentials", () =>
    HttpResponse.json([]),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const catalogImages = getAgentCatalogImages({
  registry: "registry.example.com",
  tag: "1.2.3",
});

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "test-user" } },
  } as ReturnType<typeof useSession>);
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useAppName).mockReturnValue("Test Platform");
  vi.mocked(useAppIconLogo).mockReturnValue("/logo-icon.svg");
  vi.mocked(useFeature).mockImplementation((flag) =>
    flag === "agentRuntime"
      ? true
      : flag === "agentRuntimeCatalogImages"
        ? catalogImages
        : undefined,
  );
});

describe("AgentRuntimePicker", () => {
  it("keeps a custom template's icon in its summary and editing choices", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const runtime = {
      ...defaultAgentRuntime(),
      image: "registry.example.com/team:v1",
    };
    server.use(
      http.get("http://localhost:9000/api/agent-runtime-templates", () =>
        HttpResponse.json([
          {
            id,
            name: "Team workspace",
            description: "Team tools",
            icon: "🧰",
            hidden: false,
            position: 0,
            image: runtime.image,
          },
        ]),
      ),
    );
    server.use(
      http.get("http://localhost:9000/api/teams", () =>
        HttpResponse.json({
          data: [],
          pagination: { currentPage: 1, limit: 100, total: 0, totalPages: 0 },
        }),
      ),
    );
    const props = {
      selectedId: id,
      value: runtime,
      onSelect: vi.fn(),
      onChange: vi.fn(),
      modelBlock: <div>Model settings</div>,
      modelSummary: "Model settings",
    };
    const view = render(
      <AgentRuntimePicker {...props} onChangeTemplate={vi.fn()} />,
      { wrapper: QueryWrapper },
    );
    expect(await screen.findByText("🧰")).toBeVisible();
    view.rerender(<AgentRuntimePicker {...props} />);
    expect(
      await screen.findByRole("radio", { name: "Team workspace" }),
    ).toBeChecked();
    expect(screen.getByText("🧰")).toBeVisible();
  });

  it("replaces the complete runtime when switching harnesses and removes it for the native platform agent", async () => {
    const user = userEvent.setup();
    await renderPicker("claude-code", {
      ...runtimeFor("claude-code"),
      environment: [{ key: "OLD_SETTING", value: "old" }],
      credentials: [
        { key: "OLD_TOKEN", label: "Token", required: true, scope: "shared" },
      ],
      ttlHours: 12,
    });
    expect(
      screen.queryByRole("radio", { name: "Test Platform Agent" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Container image")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "OpenCode" }));
    expect(savedRuntime()).toEqual(runtimeFor("opencode"));
    expect(savedRuntime().claudeCode).toBeUndefined();
    await user.click(screen.getByRole("radio", { name: "Codex" }));
    await user.click(screen.getByRole("radio", { name: "Test Platform" }));
    expect(savedRuntime()).toBeNull();
    expect(screen.getByText("Model settings content")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Image/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a runtime picked in the catalog as a summary, and sends Change back to the catalog", async () => {
    const user = userEvent.setup();
    const onChangeTemplate = vi.fn();
    render(
      <AgentRuntimePicker
        selectedId="claude-code"
        value={runtimeFor("claude-code")}
        onSelect={vi.fn()}
        onChange={vi.fn()}
        modelBlock={<div>Model settings content</div>}
        modelSummary="summary"
        onChangeTemplate={onChangeTemplate}
      />,
      { wrapper: QueryWrapper },
    );
    expect(
      await screen.findByText("Claude Code in its own container"),
    ).toBeVisible();
    expect(
      screen.queryByRole("radiogroup", { name: "Runtime" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(onChangeTemplate).toHaveBeenCalledOnce();
  });

  it("locks Claude Code to Anthropic and limits Codex to the two OpenAI protocols", async () => {
    const user = userEvent.setup();
    await renderPicker("claude-code");
    // One protocol leaves nothing to choose, so the row is not offered.
    expect(
      screen.queryByRole("button", { name: /^Inference API/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Codex" }));
    await user.click(screen.getByRole("button", { name: /^Inference API/ }));
    await user.click(screen.getByLabelText("Inference API"));
    expect(
      screen.queryByRole("option", { name: "Anthropic Messages" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("option", { name: "OpenAI Chat Completions" }),
    );
    expect(savedRuntime().inferenceProtocol).toBe("openai_chat");
  });

  it("keeps Kimi Code on Chat Completions without offering a protocol choice", async () => {
    const user = userEvent.setup();
    await renderPicker("codex");
    await user.click(screen.getByRole("radio", { name: "Kimi Code" }));
    expect(
      screen.queryByRole("button", { name: /^Inference API/ }),
    ).not.toBeInTheDocument();
    expect(savedRuntime()).toMatchObject({
      command: ["archestra-kimi"],
      inferenceProtocol: "openai_chat",
    });
  });

  it("keeps Grok Build on Chat Completions without offering a protocol choice", async () => {
    const user = userEvent.setup();
    await renderPicker("codex");
    await user.click(screen.getByRole("radio", { name: "Grok Build" }));
    expect(
      screen.queryByRole("button", { name: /^Inference API/ }),
    ).not.toBeInTheDocument();
    expect(savedRuntime()).toMatchObject({
      command: ["archestra-grok"],
      inferenceProtocol: "openai_chat",
    });
  });

  it("selects Copilot CLI with native terminal input and its supported model protocol", async () => {
    const user = userEvent.setup();
    await renderPicker("codex");
    await user.click(screen.getByRole("radio", { name: "GitHub Copilot CLI" }));
    expect(
      screen.queryByRole("button", { name: /^Inference API/ }),
    ).not.toBeInTheDocument();
    expect(savedRuntime()).toMatchObject({
      command: ["archestra-copilot"],
      inferenceProtocol: "openai_chat",
      steerMode: "tmux_keys",
    });
  });

  it("corrects incompatible protocols when a custom command changes harnesses, retaining compatible choices", async () => {
    const user = userEvent.setup();
    await renderPicker("custom");
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "archestra-claude-code" },
    });
    expect(savedRuntime().inferenceProtocol).toBe("anthropic");
    expect(
      screen.queryByRole("button", { name: /^Inference API/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Whose Claude account runs it/ }),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "archestra-codex" },
    });
    expect(savedRuntime().inferenceProtocol).toBe("openai_responses");
    expect(screen.getByLabelText("Inference API")).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Model/ })).toBeVisible();
    await user.click(screen.getByLabelText("Inference API"));
    await user.click(
      screen.getByRole("option", { name: "OpenAI Chat Completions" }),
    );
    fireEvent.change(screen.getByLabelText("Arguments (one per line)"), {
      target: { value: "--verbose" },
    });
    expect(savedRuntime().inferenceProtocol).toBe("openai_chat");
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "custom-command" },
    });
    expect(savedRuntime().inferenceProtocol).toBe("openai_chat");
  });

  it("resolves a custom template on selection without putting environment values in the catalog list", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const runtime = {
      ...defaultAgentRuntime(),
      image: "registry.example.com/team-agent:v2",
      command: ["team-agent", "--serve"],
      environment: [{ key: "TEAM_MODE", value: "review" }],
    };
    const summary = {
      id,
      name: "Team workspace",
      description: "Team tools",
      icon: null,
      hidden: false,
      position: 0,
      image: runtime.image,
    };
    server.use(
      http.get("http://localhost:9000/api/agent-runtime-templates", () =>
        HttpResponse.json([summary]),
      ),
      http.get(`http://localhost:9000/api/agent-runtime-templates/${id}`, () =>
        HttpResponse.json({ ...summary, runtime }),
      ),
    );
    await renderPicker("chat");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Team workspace" }));
    await waitFor(() => expect(savedRuntime()).toEqual(runtime));
    expect(screen.getByRole("radio", { name: "Team workspace" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Test Platform" }));
    expect(savedRuntime()).toBeNull();
  });

  it("opens Custom image setup and preserves edits through disclosure changes", async () => {
    const user = userEvent.setup();
    await renderPicker("chat");
    await user.click(screen.getByRole("radio", { name: "Custom image" }));
    expect(screen.getByText("Model settings content")).toBeVisible();
    // Custom image starts empty: it must not quietly fall back to the
    // platform's own runtime image.
    expect(screen.getByLabelText("Container image")).toHaveValue("");
    expect(
      screen.getByRole("img", {
        name: "Set a container image before creating the agent",
      }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Container image"), {
      target: { value: "registry.example.com/custom:2" },
    });
    await user.click(screen.getByRole("button", { name: /^Image/ }));
    expect(screen.getByRole("button", { name: /^Image/ })).toHaveTextContent(
      "registry.example.com/custom:2",
    );
    await user.click(screen.getByLabelText("Inference API"));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.click(
      screen.getByRole("option", { name: "Anthropic Messages" }),
    );
    await user.click(screen.getByRole("button", { name: /^Limits/ }));
    // Tiers and access are in view with the limits: nothing folds away.
    expect(screen.getByLabelText("Default tier")).toBeVisible();
    expect(screen.getByLabelText("Privileged mode")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Metered LLM budget"), {
      target: { value: "25" },
    });
    expect(screen.getByRole("button", { name: /^Limits/ })).toHaveTextContent(
      "$25 LLM budget",
    );
    await user.click(screen.getByRole("radio", { name: "OpenCode" }));
    expect(savedRuntime()).toEqual(runtimeFor("opencode"));
    expect(screen.queryByLabelText("Container image")).not.toBeInTheDocument();
  });

  it("opens authentication by default and keeps pending setup visible when collapsed", async () => {
    const user = userEvent.setup();
    const props = {
      selectedId: "claude-code" as const,
      value: runtimeFor("claude-code"),
      onSelect: vi.fn(),
      onChange: vi.fn(),
      modelBlock: <div>Model settings content</div>,
      modelSummary: "Provider connection",
      modelAttention: "Select a provider and Claude model",
    };
    const { rerender } = render(<AgentRuntimePicker {...props} />, {
      wrapper: QueryWrapper,
    });
    await screen.findByRole("radio", { name: "Claude Code" });
    await user.hover(screen.getByRole("img", { name: props.modelAttention }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      props.modelAttention,
    );
    await user.unhover(screen.getByRole("img", { name: props.modelAttention }));
    await user.tab();
    await user.tab();
    expect(
      screen.getByRole("button", { name: /^Whose Claude account runs it/ }),
    ).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      props.modelAttention,
    );
    expect(screen.getByText("Model settings content")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: /^Whose Claude account runs it/ }),
    );
    expect(
      screen.queryByText("Model settings content"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: props.modelAttention }),
    ).toBeVisible();
    rerender(<AgentRuntimePicker {...props} modelAttention={undefined} />);
    expect(
      screen.queryByRole("img", { name: props.modelAttention }),
    ).not.toBeInTheDocument();
    rerender(
      <AgentRuntimePicker
        {...props}
        selectedId="opencode"
        value={runtimeFor("opencode")}
        modelAttention={undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /^Model/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Model settings content")).toBeVisible();
  });
});

function runtimeFor(
  id: Exclude<AgentRuntimeSelection, "chat">,
): AgentRuntimeConfig {
  return (
    getAgentCatalogTemplates(catalogImages, "Test Platform").find(
      (template) => template.id === id,
    )?.initialValues.runtime ?? defaultAgentRuntime()
  );
}

async function renderPicker(
  initialId: AgentRuntimeSelection,
  initialRuntime?: AgentRuntimeConfig,
) {
  const view = render(
    <Harness initialId={initialId} initialRuntime={initialRuntime} />,
    { wrapper: QueryWrapper },
  );
  await screen.findByRole("radio", { name: "Claude Code" });
  return view;
}

function QueryWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function savedRuntime() {
  return JSON.parse(screen.getByTestId("runtime-state").textContent ?? "null");
}

function Harness({
  initialId,
  initialRuntime,
}: {
  initialId: AgentRuntimeSelection;
  initialRuntime?: AgentRuntimeConfig;
}) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [runtime, setRuntime] = useState<AgentRuntimeConfig | null>(
    initialRuntime ?? (initialId === "chat" ? null : runtimeFor(initialId)),
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
        modelBlock={<div>Model settings content</div>}
        modelSummary="Provider connection"
      />
      <output data-testid="runtime-state">{JSON.stringify(runtime)}</output>
    </>
  );
}

describe("custom runtime catalog permission integration", () => {
  it.each([
    false,
    true,
  ])("gates custom template selection on Configure runtime (%s)", async (allowed) => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: allowed,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    const id = "00000000-0000-4000-8000-000000000001";
    const runtime = {
      ...defaultAgentRuntime(),
      image: "registry.example.com/team-agent:v2",
      environment: [{ key: "TEAM_MODE", value: "review" }],
    };
    const summary = {
      id,
      name: "Team workspace",
      description: "Team tools",
      icon: null,
      hidden: false,
      position: 0,
      image: runtime.image,
    };
    let resolutions = 0;
    server.use(
      http.get("http://localhost:9000/api/agent-runtime-templates", () =>
        HttpResponse.json([summary]),
      ),
      http.get(
        `http://localhost:9000/api/agent-runtime-templates/${id}`,
        () => {
          resolutions++;
          return HttpResponse.json({ ...summary, runtime });
        },
      ),
    );
    const onSelect = vi.fn();
    render(
      <AgentCatalog
        canCreateAgent
        runtimeAvailable
        onStartFromScratch={vi.fn()}
        onStartFromImage={vi.fn()}
        onAddExternalAgent={vi.fn()}
        onSelect={onSelect}
      />,
      { wrapper: QueryWrapper },
    );
    const choice = await screen.findByRole("button", {
      name: /Team workspace/,
    });
    const user = userEvent.setup();
    if (allowed) {
      expect(choice).toBeEnabled();
      await user.click(choice);
      await waitFor(() =>
        expect(onSelect).toHaveBeenCalledWith(
          expect.objectContaining({
            customTemplateId: id,
            initialValues: expect.objectContaining({ runtime }),
          }),
        ),
      );
      expect(resolutions).toBe(1);
    } else {
      expect(choice).toBeDisabled();
      expect(choice).toHaveAccessibleDescription(
        "Requires Configure runtime permission.",
      );
      await user.click(choice);
      expect(resolutions).toBe(0);
      expect(onSelect).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: /New Test Platform agent/ }),
      ).toBeEnabled();
    }
  });
});
