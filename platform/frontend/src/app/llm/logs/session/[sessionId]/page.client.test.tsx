import { render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useInteractionSessions,
  useInteractions,
} from "@/lib/interactions/interaction.query";
import SessionDetailPage from "./page.client";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock("@/lib/interactions/interaction.query", () => ({
  useInteractions: vi.fn(),
  useInteractionSessions: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    use: () => ({ sessionId: "test-session" }),
  };
});

describe("SessionDetailPage", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useInteractionSessions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useInteractionSessions>);
  });

  it("shows a loading state while session interactions are loading", async () => {
    vi.mocked(useInteractions).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useInteractions>);

    renderSessionDetailPage();

    expect(await screen.findByText("Loading session logs...")).toBeVisible();
    expect(
      screen.queryByText("No interactions found for this session"),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state after session interactions finish loading empty", async () => {
    vi.mocked(useInteractions).mockReturnValue({
      data: {
        data: [],
        pagination: {
          currentPage: 1,
          limit: 50,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useInteractions>);

    renderSessionDetailPage();

    expect(
      await screen.findByText("No interactions found for this session"),
    ).toBeVisible();
    expect(
      screen.queryByText("Loading session logs..."),
    ).not.toBeInTheDocument();
  });
});

function renderSessionDetailPage() {
  return render(
    <SessionDetailPage
      paramsPromise={Promise.resolve({ sessionId: "test-session" })}
    />,
  );
}
