import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConnectWithAi } from "./connect-with-ai";

vi.mock("sonner");

test("copies a deployment-specific prompt and returns to the page on close", async () => {
  const user = userEvent.setup();
  render(<ConnectWithAi />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Connect with your AI" }),
  );
  const prompt = `Read ${window.location.origin}/connect.md and connect this client.`;
  expect(screen.getByText(prompt)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
  expect(await navigator.clipboard.readText()).toBe(prompt);
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Connect with your AI" }));
  expect(screen.getByText(prompt)).toBeVisible();
});
