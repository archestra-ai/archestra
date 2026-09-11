import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectWithAi } from "./connect-with-ai";

vi.mock("sonner");

test.each([
  "claude-code",
  "codex",
  "copilot-cli",
])("copies the deployment prompt for %s", async (id) => {
  const user = userEvent.setup();
  const client = CONNECT_CLIENTS.find((entry) => entry.id === id);
  if (!client) throw new Error("Missing client");
  render(<ConnectWithAi client={client} />);
  const prompt = `Read ${window.location.origin}/connect.md and connect ${client.label}.`;
  expect(screen.getByText(prompt)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await navigator.clipboard.readText()).toBe(prompt);
  expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
});
