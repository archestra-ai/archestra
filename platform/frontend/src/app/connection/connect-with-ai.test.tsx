import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConnectWithAi } from "./connect-with-ai";

vi.mock("sonner");

test("copies the current deployment prompt and offers the manual fallback", async () => {
  const user = userEvent.setup();
  const onManualSetup = vi.fn();
  render(<ConnectWithAi onManualSetup={onManualSetup} />);
  const prompt = `Read ${window.location.origin}/connect.md and connect this client.`;
  expect(screen.getByText(prompt)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy prompt" }));
  expect(await navigator.clipboard.readText()).toBe(prompt);
  expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Other ways to connect" }),
  );
  expect(onManualSetup).toHaveBeenCalledOnce();
});

test("identifies Claude Code and Claude Desktop in their logo tooltips", async () => {
  const user = userEvent.setup();
  render(<ConnectWithAi onManualSetup={() => {}} />);
  await user.hover(screen.getByRole("button", { name: "Claude Code" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Claude Code");
  await user.unhover(screen.getByRole("button", { name: "Claude Code" }));
  await user.hover(screen.getByRole("button", { name: "Claude Desktop" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Claude Desktop",
  );
});
