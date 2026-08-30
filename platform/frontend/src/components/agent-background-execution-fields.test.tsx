import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { useExecutionCredentials } from "@/lib/execution-credentials.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  AgentBackgroundExecutionFields,
  type BackgroundExecutionConfig,
} from "./agent-background-execution-fields";

Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

vi.mock("@/lib/config/config.query", () => ({
  useFeature: vi.fn(),
}));
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/execution-credentials.query", () => ({
  useExecutionCredentials: vi.fn(),
}));

describe("AgentBackgroundExecutionFields", () => {
  beforeEach(() => {
    vi.mocked(useExecutionCredentials).mockReturnValue({
      data: [
        {
          key: "github",
          name: "GitHub PAT",
          description: "Access GitHub repositories",
          icon: "logo:github",
          builtIn: true,
          allowPersonal: true,
          allowOrganization: false,
          personalConfigured: false,
          organizationConfigured: false,
        },
        {
          key: "gitlab-pat",
          name: "GitLab PAT",
          description: "Access GitLab repositories",
          icon: null,
          builtIn: false,
          allowPersonal: false,
          allowOrganization: true,
          personalConfigured: false,
          organizationConfigured: false,
        },
      ],
    } as ReturnType<typeof useExecutionCredentials>);
  });

  it("starts with the configured image and preserves explicit run controls", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) => {
      if (flag === "agentBackgroundExecution") return true;
      if (flag === "agentBackgroundExecutionBaseImage") {
        return "registry.example.com/coding-agent:1.2.3";
      }
      return undefined;
    });
    const user = userEvent.setup();

    render(<Harness />);
    await user.click(
      screen.getByRole("switch", { name: "Background execution" }),
    );

    expect(screen.getByLabelText("Container image")).toHaveValue(
      "registry.example.com/coding-agent:1.2.3",
    );
    expect(
      screen.getByText(/delivers follow-up instructions between Agent turns/i),
    ).toBeVisible();
    expect(
      screen.getByText(/Stops the deployment after it finishes a task/i),
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
    await user.type(
      within(variableDialog).getByLabelText("Value"),
      "background",
    );
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
      environment: [{ key: "WORK_MODE", value: "background" }],
    });
  });

  it("binds built-in and organization-defined credentials to image-specific environment variable names", async () => {
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useFeature).mockImplementation((flag) =>
      flag === "agentBackgroundExecution" ? true : undefined,
    );
    const user = userEvent.setup();

    render(<Harness />);
    await user.click(
      screen.getByRole("switch", { name: "Background execution" }),
    );

    await user.click(screen.getByRole("button", { name: "Add variable" }));
    let dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText("Type"));
    await user.click(screen.getByRole("option", { name: "Secret" }));
    await user.click(within(dialog).getByLabelText("Secret source"));
    await user.click(screen.getByRole("option", { name: "GitHub PAT" }));
    expect(within(dialog).getByLabelText("Key")).toHaveValue("GITHUB_TOKEN");
    await user.click(
      within(dialog).getByRole("button", { name: "Add variable" }),
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
});

function Harness() {
  const [value, setValue] = useState<BackgroundExecutionConfig | null>(null);
  return (
    <>
      <AgentBackgroundExecutionFields value={value} onChange={setValue} />
      <output data-testid="config">{JSON.stringify(value)}</output>
    </>
  );
}
