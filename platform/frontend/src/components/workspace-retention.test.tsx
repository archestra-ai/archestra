import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceRetention } from "./workspace-retention";

afterEach(() => vi.useRealTimers());

it("shows a compact countdown and retains the exact deadline on hover", () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-09T12:00:00Z");
  const expiresAt = "2026-09-11T17:00:00Z";
  render(<WorkspaceRetention expiresAt={expiresAt} />);
  const time = screen.getByText("Retained for 2d 5h");
  expect(time).toHaveAttribute("datetime", new Date(expiresAt).toISOString());
  expect(time).toHaveAttribute(
    "title",
    `Retained until ${new Date(expiresAt).toLocaleString()}`,
  );
  act(() => vi.advanceTimersByTime(60 * 60_000));
  expect(screen.getByText("Retained for 2d 4h")).toBeInTheDocument();
});

it("does not imply that expired storage is still retained", () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-09T12:00:00Z");
  render(<WorkspaceRetention expiresAt="2026-09-09T12:00:30Z" />);
  expect(screen.getByText("Retained for less than 1m")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByText("Retention expired")).toBeInTheDocument();
});
