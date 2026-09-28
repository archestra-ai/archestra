import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectWithAi } from "./connect-with-ai";

vi.mock("sonner");
vi.mock("@/lib/hooks/use-app-name");

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Example Platform");
});

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
  const prompt = `Read ${window.location.origin}/connect.md?client=${id} and connect ${client.label}.`;
  expect(screen.getByText(prompt)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await navigator.clipboard.readText()).toBe(prompt);
  expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
});

test("Cursor explains how to opt into proxy inference", () => {
  const cursor = CONNECT_CLIENTS.find((entry) => entry.id === "cursor");
  const claudeCode = CONNECT_CLIENTS.find(
    (entry) => entry.id === "claude-code",
  );
  if (!cursor || !claudeCode) throw new Error("Missing client");

  const view = render(<ConnectWithAi client={cursor} />);
  const notice = screen.getByRole("alert");
  expect(notice.nextElementSibling).toHaveTextContent(
    "Paste this prompt into Cursor",
  );
  expect(notice).toHaveTextContent(
    "Using Example Platform for Cursor's AI requests",
  );
  expect(notice).toHaveTextContent(
    "Connecting Cursor here adds Example Platform tools and skills",
  );
  expect(notice).toHaveTextContent("Cursor keeps using its current models");
  expect(notice).toHaveTextContent("Customize setup");
  expect(notice).toHaveTextContent("Cursor model settings (manual step)");
  expect(notice).toHaveTextContent("installer output");
  expect(notice).toHaveTextContent("Otherwise use your own OpenAI API key");
  expect(notice).toHaveTextContent("Override OpenAI Base URL");
  expect(notice).toHaveTextContent(
    "a Cursor subscription cannot be used as a key",
  );

  view.rerender(<ConnectWithAi client={claudeCode} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
