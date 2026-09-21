import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";
import { siGithub } from "simple-icons";
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
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type AgentRuntimeConfig,
  AgentRuntimeFields,
} from "./agent-runtime-fields";

Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AgentRuntimeFields", () => {
  beforeEach(() => {
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    server.use(
      http.get("http://localhost:9000/api/credentials", () =>
        HttpResponse.json([
          {
            key: "github",
            name: "Repository access",
            kind: "github_app_user",
            description: "Access GitHub repositories",
            icon: null,
            builtIn: true,
            allowPersonal: true,
            allowOrganization: false,
            personalConfigured: false,
            organizationConfigured: false,
          },
          {
            key: "gitlab-pat",
            name: "GitLab PAT",
            kind: "secret",
            description: "Access GitLab repositories",
            icon: null,
            builtIn: false,
            allowPersonal: false,
            allowOrganization: true,
            personalConfigured: false,
            organizationConfigured: false,
          },
        ]),
      ),
    );
  });

  it("starts with the configured image and preserves explicit run controls", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) => {
      if (flag === "agentRuntime") return true;
      if (flag === "agentRuntimeBaseImage") {
        return "registry.example.com/coding-agent:1.2.3";
      }
      if (flag === "agentRuntimeBackend") {
        return {
          name: "kubernetes",
          available: true,
          defaultImage: "",
          defaultTtlHours: 36,
          defaultIdleTimeoutMinutes: 45,
          allowPrivileged: false,
          resources: {
            cpuRequest: "750m",
            memoryRequest: "2Gi",
            memoryLimit: "6Gi",
          },
        };
      }
      return undefined;
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness />
      </QueryClientProvider>,
    );
    await user.click(
      screen.getByRole("switch", { name: "Dedicated Agent runtime" }),
    );

    expect(screen.getByLabelText("Container image")).toHaveValue(
      "registry.example.com/coding-agent:1.2.3",
    );
    expect(screen.getByLabelText("Inference API")).toBeVisible();
    expect(screen.getByLabelText("Steering")).toBeVisible();
    expect(
      screen.queryByLabelText("Maximum duration (hours)"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Advanced$/ }));
    expect(screen.getByLabelText("Maximum duration (hours)")).toHaveAttribute(
      "placeholder",
      "36 (Installation Default)",
    );
    expect(screen.getByLabelText("Idle timeout (minutes)")).toHaveAttribute(
      "placeholder",
      "45 (Installation Default)",
    );
    expect(screen.getByLabelText("Memory limit")).toHaveAttribute(
      "placeholder",
      "6Gi (Installation Default)",
    );
    expect(screen.getByLabelText("Metered LLM budget (USD)")).toHaveAttribute(
      "placeholder",
      "No limit (Installation Default)",
    );
    expect(screen.getByLabelText("Ports to forward")).toHaveValue("");
    await user.type(screen.getByLabelText("Ports to forward"), "3000, 9000");
    expect(
      JSON.parse(screen.getByTestId("config").textContent ?? "{}").ports,
    ).toEqual([3000, 9000]);
    expect(
      screen.getByText(/delivers follow-up instructions between Agent turns/i),
    ).toBeVisible();
    expect(
      screen.getByText(/Stops the run after it finishes a task/i),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Command"), "claude");
    fireEvent.change(screen.getByLabelText("Arguments (one per line)"), {
      target: { value: "--permission-mode\nbypassPermissions" },
    });
    await user.type(screen.getByLabelText("Maximum duration (hours)"), "12");
    await user.type(screen.getByLabelText("Memory limit"), "8Gi");
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const variableDialog = screen.getByRole("dialog");
    await user.type(within(variableDialog).getByLabelText("Key"), "WORK_MODE");
    await user.type(within(variableDialog).getByLabelText("Value"), "runtime");
    await user.click(
      within(variableDialog).getByRole("button", { name: "Add variable" }),
    );

    const saved = JSON.parse(
      screen.getByTestId("config").textContent ?? "null",
    );
    expect(saved).toMatchObject({
      image: "registry.example.com/coding-agent:1.2.3",
      command: ["claude", "--permission-mode", "bypassPermissions"],
      ttlHours: 12,
      resources: { memoryLimit: "8Gi" },
      environment: [{ key: "WORK_MODE", value: "runtime" }],
    });
  });

  it("binds built-in and organization-defined credentials to image-specific environment variable names", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "agentRuntime" ? true : undefined,
    );
    const user = userEvent.setup();

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness />
      </QueryClientProvider>,
    );
    await user.click(
      screen.getByRole("switch", { name: "Dedicated Agent runtime" }),
    );

    await user.click(screen.getByRole("button", { name: "Add variable" }));
    let dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText("Type"));
    await user.click(screen.getByRole("option", { name: "Secret" }));
    await user.click(within(dialog).getByLabelText("Secret source"));
    const githubOption = await screen.findByRole("option", {
      name: "Repository access",
    });
    expect(githubOption).toHaveTextContent("GitHub connection");
    expect(githubOption.querySelector("svg path")).toHaveAttribute(
      "d",
      siGithub.path,
    );
    await user.click(githubOption);
    expect(within(dialog).getByLabelText("Key")).toHaveValue("GITHUB_TOKEN");
    await user.click(
      within(dialog).getByRole("button", { name: "Add variable" }),
    );

    expect(screen.getByText("GitHub connection")).toBeVisible();
    expect(
      Array.from(
        screen
          .getByRole("button", { name: /GITHUB_TOKEN/ })
          .querySelectorAll("svg path"),
        (path) => path.getAttribute("d"),
      ),
    ).toContain(siGithub.path);
    expect(screen.getByRole("link", { name: "Credentials" })).toHaveAttribute(
      "href",
      "/settings/credentials",
    );
    await user.click(screen.getByRole("button", { name: /GITHUB_TOKEN/ }));
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Secret source"),
    ).toHaveTextContent("Repository access");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Add variable" }));
    dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText("Type"));
    await user.click(screen.getByRole("option", { name: "Secret" }));
    await user.click(within(dialog).getByLabelText("Secret source"));
    await user.click(screen.getByRole("option", { name: "GitLab PAT" }));
    fireEvent.change(within(dialog).getByLabelText("Key"), {
      target: { value: "DEPLOY_API_KEY" },
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Add variable" }),
    );

    expect(screen.getByText("Organization credential")).toBeVisible();
    const saved = JSON.parse(
      screen.getByTestId("config").textContent ?? "null",
    );
    expect(saved.credentials).toEqual([
      expect.objectContaining({
        key: "GITHUB_TOKEN",
        credentialId: "github",
        scope: "per_user",
      }),
      expect.objectContaining({
        key: "DEPLOY_API_KEY",
        credentialId: "gitlab-pat",
        scope: "shared",
      }),
    ]);
  });

  // The backend reads an absent value as enabled, so the switch has to show
  // enabled for a config that never set the field, and write an explicit
  // `false` when an administrator turns it off.
  it("shows client-supplied credentials as accepted until turned off", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "agentRuntime" ? true : undefined,
    );
    const user = userEvent.setup();

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness />
      </QueryClientProvider>,
    );
    await user.click(
      screen.getByRole("switch", { name: "Dedicated Agent runtime" }),
    );

    const toggle = screen.getByRole("switch", {
      name: "Accept credentials from a connected client",
    });
    expect(toggle).toBeChecked();
    expect(
      JSON.parse(screen.getByTestId("config").textContent ?? "{}"),
    ).not.toHaveProperty("allowAgentSuppliedCredentialValues");

    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(
      JSON.parse(screen.getByTestId("config").textContent ?? "{}"),
    ).toMatchObject({ allowAgentSuppliedCredentialValues: false });
  });
});

function Harness() {
  const [value, setValue] = useState<AgentRuntimeConfig | null>(null);
  return (
    <>
      <AgentRuntimeFields value={value} onChange={setValue} />
      <output data-testid="config">{JSON.stringify(value)}</output>
    </>
  );
}
