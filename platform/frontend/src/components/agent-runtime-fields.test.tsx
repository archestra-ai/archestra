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
import { useSettingsAreaAccess } from "@/app/_parts/use-settings-area-access";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type AgentRuntimeConfig,
  AgentRuntimeFields,
  defaultAgentRuntime,
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

vi.mock("@/app/_parts/use-settings-area-access");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
vi.mock("@/lib/hooks/use-app-name");
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AgentRuntimeFields", () => {
  beforeEach(() => {
    vi.mocked(useSettingsAreaAccess).mockReturnValue(true);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    // Every saved credential is usable, so each can be attached.
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [{ resource: "credential", action: "use", scope: "*" }],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Ada", email: "ada@example.com" } },
    } as unknown as ReturnType<typeof useSession>);
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

  it("starts without an image and preserves explicit run controls", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) => {
      if (flag === "agentRuntime") return true;
      if (flag === "agentRuntimeBackend") {
        return {
          name: "kubernetes",
          available: true,
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

    expect(screen.getByLabelText("Container image")).toHaveValue("");
    expect(screen.getByLabelText("Inference API")).toBeVisible();
    expect(screen.getByLabelText("Steering")).toBeVisible();
    expect(screen.getByLabelText("Maximum duration")).toHaveAttribute(
      "placeholder",
      "36 (default)",
    );
    expect(screen.getByLabelText("Idle timeout")).toHaveAttribute(
      "placeholder",
      "45 (default)",
    );
    expect(screen.getByLabelText("Metered LLM budget")).toHaveAttribute(
      "placeholder",
      "No limit (default)",
    );
    // Resources, ports, and privileged mode stay closed behind a summary.
    expect(screen.queryByLabelText("Memory limit")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Resources and access/ }),
    );
    expect(screen.getByLabelText("Memory limit")).toHaveAttribute(
      "placeholder",
      "6Gi (default)",
    );
    expect(screen.getByLabelText("Ports to forward")).toHaveValue("");
    await user.type(screen.getByLabelText("Ports to forward"), "3000, 9000");
    expect(
      JSON.parse(screen.getByTestId("config").textContent ?? "{}").ports,
    ).toEqual([3000, 9000]);
    fireEvent.change(screen.getByLabelText("Ports to forward"), {
      target: { value: "3000, 3000, 9000" },
    });
    expect(
      JSON.parse(screen.getByTestId("config").textContent ?? "{}").ports,
    ).toEqual([3000, 9000]);
    fireEvent.change(screen.getByLabelText("Ports to forward"), {
      target: {
        value: Array.from({ length: 21 }, (_, index) => index + 1).join(", "),
      },
    });
    expect(screen.getByLabelText("Ports to forward")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      JSON.parse(screen.getByTestId("config").textContent ?? "{}").ports,
    ).toEqual([3000, 9000]);
    expect(
      screen.getByText(/Follow-ups are delivered between turns/i),
    ).toBeVisible();
    expect(
      screen.getByText(/Stops the run after it finishes a task/i),
    ).toBeVisible();

    await user.type(
      screen.getByLabelText("Container image"),
      "registry.example.com/coding-agent:1.2.3",
    );
    await user.type(screen.getByLabelText("Command"), "claude");
    fireEvent.change(screen.getByLabelText("Arguments (one per line)"), {
      target: { value: "--permission-mode\nbypassPermissions" },
    });
    await user.type(screen.getByLabelText("Maximum duration"), "12");
    await user.type(screen.getByLabelText("Memory limit"), "8Gi");
    await user.click(
      screen.getByRole("button", { name: /^(Add variable|Add)$/ }),
    );
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

    await user.click(
      screen.getByRole("button", { name: /^(Add variable|Add)$/ }),
    );
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
    expect(within(dialog).getByLabelText("Description")).toHaveValue("");
    await user.click(
      within(dialog).getByRole("button", { name: "Add variable" }),
    );

    expect(screen.getByText("GitHub connection")).toBeVisible();
    expect(
      Array.from(
        (
          screen.getByText("GITHUB_TOKEN").closest("li") as HTMLElement
        ).querySelectorAll("svg path"),
        (path) => path.getAttribute("d"),
      ),
    ).toContain(siGithub.path);
    expect(screen.getByRole("link", { name: "Credentials" })).toHaveAttribute(
      "href",
      "/settings/credentials",
    );
    await user.click(screen.getByRole("button", { name: "Edit GITHUB_TOKEN" }));
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Secret source"),
    ).toHaveTextContent("Repository access");
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Description"),
    ).toHaveValue("");
    dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Description"),
      "Use for repository reviews",
    );
    await user.click(within(dialog).getByLabelText("Secret source"));
    await user.click(screen.getByRole("option", { name: "GitLab PAT" }));
    expect(within(dialog).getByLabelText("Description")).toHaveValue(
      "Use for repository reviews",
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await user.click(screen.getByRole("button", { name: "Edit GITHUB_TOKEN" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Secret source")).toHaveTextContent(
      "Repository access",
    );
    expect(within(dialog).getByLabelText("Description")).toHaveValue("");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await user.click(
      screen.getByRole("button", { name: /^(Add variable|Add)$/ }),
    );
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

    expect(screen.getByText("Organization credential · set")).toBeVisible();
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
    expect(saved.credentials[0].description).toBeUndefined();
  });

  it("points a reader without Settings at their own credentials", async () => {
    vi.mocked(useSettingsAreaAccess).mockReturnValue(false);
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
    expect(screen.getByRole("link", { name: "Credentials" })).toHaveAttribute(
      "href",
      "/account/credentials",
    );
  });

  // The backend reads an absent value as enabled, so the switch has to show
  // enabled for a config that never set the field, and write an explicit
  // `false` when an administrator turns it off.
  it("lets a saved runtime be turned off once the deployment has none", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "agentRuntime" ? false : undefined,
    );
    const user = userEvent.setup();

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness initial={defaultAgentRuntime()} />
      </QueryClientProvider>,
    );
    const toggle = screen.getByRole("switch", {
      name: "Dedicated Agent runtime",
    });
    expect(toggle).toBeEnabled();
    expect(
      screen.getByText(/Agent Runtime is off on this deployment/),
    ).toBeVisible();

    await user.click(toggle);

    expect(screen.getByTestId("config")).toHaveTextContent("null");
    // Nothing to turn it back on with.
    expect(toggle).toBeDisabled();
  });

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

  it("creates a credential from the variable dialog and comes back with it selected", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "agentRuntime" ? true : undefined,
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    const created = {
      id: "cred-npm",
      key: "npm-token",
      name: "NPM_TOKEN",
      kind: "secret",
      description: "Install private packages",
      icon: null,
      builtIn: false,
      allowPersonal: false,
      allowOrganization: true,
      personalConfigured: false,
      organizationConfigured: false,
    };
    let saved = false;
    server.use(
      http.get("http://localhost:9000/api/credentials", () =>
        HttpResponse.json(saved ? [created] : []),
      ),
      http.post("http://localhost:9000/api/credentials", async () => {
        saved = true;
        return HttpResponse.json(created);
      }),
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
    await user.click(
      screen.getByRole("button", { name: /^(Add variable|Add)$/ }),
    );
    const variableDialog = screen.getByRole("dialog");
    fireEvent.change(within(variableDialog).getByLabelText("Key"), {
      target: { value: "NPM_TOKEN" },
    });
    await user.click(within(variableDialog).getByLabelText("Type"));
    await user.click(screen.getByRole("option", { name: "Secret" }));
    await user.click(within(variableDialog).getByLabelText("Secret source"));
    await user.click(
      await screen.findByRole("option", {
        name: /Create credential "NPM_TOKEN"/,
      }),
    );

    const credentialDialog = await screen.findByRole("dialog", {
      name: "Add credential",
    });
    // Prefilled from the variable it was opened for.
    expect(within(credentialDialog).getByLabelText("Name")).toHaveValue(
      "NPM_TOKEN",
    );
    await user.click(
      within(credentialDialog).getByRole("button", { name: "Add" }),
    );

    expect(
      await within(screen.getByRole("dialog")).findByText("NPM_TOKEN", {
        selector: "[id='env-var-credential-binding'] *",
      }),
    ).toBeVisible();
  });
});

function Harness({ initial = null }: { initial?: AgentRuntimeConfig | null }) {
  const [value, setValue] = useState<AgentRuntimeConfig | null>(initial);
  return (
    <>
      <AgentRuntimeFields value={value} onChange={setValue} />
      <output data-testid="config">{JSON.stringify(value)}</output>
    </>
  );
}
