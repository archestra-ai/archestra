import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import {
  AgentBackgroundExecutionFields,
  type BackgroundExecutionConfig,
} from "./agent-background-execution-fields";

vi.mock("@/lib/config/config.query", () => ({
  useFeature: vi.fn(),
}));

describe("AgentBackgroundExecutionFields", () => {
  it("starts with the configured image and preserves explicit run controls", async () => {
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
