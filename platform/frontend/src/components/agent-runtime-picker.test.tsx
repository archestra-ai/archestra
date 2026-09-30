import { archestraApiClient, getAgentCatalogImages } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
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
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { makeOrganization } from "@/mocks/data/organization";
import { getAgentCatalogTemplates } from "./agent-pages/agent-catalog";
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

  it("locks Claude Code to Anthropic and limits Codex to the two OpenAI protocols", async () => {
    const user = userEvent.setup();
    await renderPicker("claude-code");
    await user.click(screen.getByRole("button", { name: /^Inference API/ }));
    expect(screen.getByLabelText("Inference API")).toBeDisabled();
    expect(screen.getByLabelText("Inference API")).toHaveTextContent(
      "Anthropic Messages",
    );
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

  it("corrects incompatible protocols when a custom command changes harnesses, retaining compatible choices", async () => {
    const user = userEvent.setup();
    await renderPicker("custom");
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "archestra-claude-code" },
    });
    expect(savedRuntime().inferenceProtocol).toBe("anthropic");
    expect(screen.getByLabelText("Inference API")).toBeDisabled();
    expect(screen.getByLabelText("Inference API")).toHaveTextContent(
      "Anthropic Messages",
    );
    expect(
      screen.getByRole("button", { name: /^Authentication/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Inference API/ }),
    ).toHaveTextContent("Fixed for Claude Code");

    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "archestra-codex" },
    });
    expect(savedRuntime().inferenceProtocol).toBe("openai_responses");
    expect(screen.getByLabelText("Inference API")).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Model/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Inference API/ }),
    ).not.toHaveTextContent("Fixed for Claude Code");
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
    await user.click(screen.getByRole("button", { name: /^Run controls/ }));
    expect(screen.getByLabelText("Privileged mode")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Metered LLM budget (USD)"), {
      target: { value: "25" },
    });
    expect(
      screen.getByRole("button", { name: /^Run controls/ }),
    ).toHaveTextContent("$25 LLM budget");
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
      screen.getByRole("button", { name: /^Authentication/ }),
    ).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      props.modelAttention,
    );
    expect(screen.getByText("Model settings content")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Authentication/ }));
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
