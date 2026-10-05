import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, expect, test, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { CONNECT_CLIENTS } from "./clients";
import { ConnectWithAi } from "./connect-with-ai";

vi.mock("sonner");
vi.mock("@/lib/hooks/use-app-name");
const promptSessionQueryMock = vi.hoisted(() => vi.fn());
const refreshSessionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/connection-setup.query", () => ({
  useConnectionPromptSession: (clientId?: string) =>
    promptSessionQueryMock(clientId),
}));

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Example Platform");
  refreshSessionMock.mockReset().mockResolvedValue({
    data: { expiresAt: "2099-01-01" },
    isError: false,
  });
  promptSessionQueryMock.mockImplementation((clientId?: string) => ({
    data: clientId ? { expiresAt: "2099-01-01" } : undefined,
    isError: false,
    refetch: refreshSessionMock,
  }));
});

test("does not copy the prompt when the setup window expires", async () => {
  const user = userEvent.setup();
  const client = CONNECT_CLIENTS.find((entry) => entry.id === "claude-code");
  if (!client) throw new Error("Missing client");
  promptSessionQueryMock.mockReturnValue({
    data: { expiresAt: "2000-01-01" },
    isError: false,
    refetch: vi.fn().mockResolvedValue({
      data: { expiresAt: "2000-01-01" },
      isError: true,
    }),
  });
  render(<ConnectWithAi client={client} />);
  const previousClipboard = await navigator.clipboard.readText();
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(toast.error).toHaveBeenCalledWith(
    "Could not start connection setup. Retry.",
  );
  expect(await navigator.clipboard.readText()).toBe(previousClipboard);
});

test("copies the original prompt after renewing the setup window", async () => {
  const user = userEvent.setup();
  const client = CONNECT_CLIENTS.find((entry) => entry.id === "claude-code");
  if (!client) throw new Error("Missing client");
  promptSessionQueryMock.mockReturnValue({
    data: { expiresAt: "2000-01-01" },
    isError: false,
    refetch: vi.fn().mockResolvedValue({
      data: { expiresAt: "2099-01-01" },
      isError: false,
    }),
  });
  render(<ConnectWithAi client={client} />);
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await navigator.clipboard.readText()).toBe(
    `Read ${window.location.origin}/connect.md?client=claude-code and connect Claude Code.`,
  );
});

test("shows the unchanged prompt before setup starts", () => {
  const client = CONNECT_CLIENTS.find((entry) => entry.id === "claude-code");
  if (!client) throw new Error("Missing client");
  promptSessionQueryMock.mockReturnValue({
    data: undefined,
    isError: false,
    refetch: vi.fn(),
  });
  render(<ConnectWithAi client={client} />);
  expect(
    screen.getByText(
      (_content, node) =>
        node?.tagName === "CODE" &&
        node.textContent ===
          `Read ${window.location.origin}/connect.md?client=claude-code and connect Claude Code.`,
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy prompt" })).toBeEnabled();
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
  expect(
    screen.getByText(
      (_content, node) =>
        node?.tagName === "CODE" && node.textContent === prompt,
    ),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await navigator.clipboard.readText()).toBe(prompt);
  expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(refreshSessionMock).toHaveBeenCalledTimes(
    ["claude-code", "codex", "opencode"].includes(id) ? 1 : 0,
  );
});

test("each copy renews the setup window without changing the prompt", async () => {
  const user = userEvent.setup();
  const client = CONNECT_CLIENTS.find((entry) => entry.id === "claude-code");
  if (!client) throw new Error("Missing client");
  render(<ConnectWithAi client={client} />);
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  await user.click(screen.getByRole("button", { name: "Copied" }));
  expect(refreshSessionMock).toHaveBeenCalledTimes(2);
  expect(await navigator.clipboard.readText()).toBe(
    `Read ${window.location.origin}/connect.md?client=claude-code and connect Claude Code.`,
  );
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
    "A Cursor subscription cannot be used as a key",
  );

  view.rerender(<ConnectWithAi client={claudeCode} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
