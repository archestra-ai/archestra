import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectWithAi } from "./connect-with-ai";

vi.mock("sonner");

test.each([
  "claude-code",
  "cursor",
  "codex",
  "copilot-cli",
  "opencode",
])("copies the deployment prompt for %s", async (id) => {
  const user = userEvent.setup();
  const client = CONNECT_CLIENTS.find((entry) => entry.id === id);
  if (!client) throw new Error("Missing client");
  render(<ConnectWithAi client={client} />);
  const prompt =
    id === "claude-code"
      ? screen.getByText(
          `Read ${window.location.origin}/connect.md and connect Claude Code.`,
        ).textContent
      : screen.getByText(/Do not fetch setup instructions/).textContent;
  if (id === "claude-code") {
    expect(prompt).toBe(
      `Read ${window.location.origin}/connect.md and connect Claude Code.`,
    );
  } else {
    expect(prompt).toContain(
      `Connect ${client.label} to ${window.location.origin}.`,
    );
    expect(prompt).not.toContain("/connect.md");
    expect(prompt).toContain(
      `node "$p" --url ${window.location.origin} --client ${id}`,
    );
    expect(prompt).toContain(
      `node $p --url ${window.location.origin} --client ${id}`,
    );
    expect(prompt).toContain("matching code in their browser");
  }
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await navigator.clipboard.readText()).toBe(prompt);
  expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
});
