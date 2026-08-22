import type { archestraApiTypes } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopSessionsCard } from "./top-sessions-card";

type SessionCost =
  archestraApiTypes.GetMyUsageBreakdownResponses["200"]["topSessions"][number];

function makeSession(overrides: Partial<SessionCost> = {}): SessionCost {
  return {
    sessionId: "session-a",
    requests: 40,
    tokens: 1_200_000,
    cost: 6,
    billedCost: 0,
    startedAt: "2026-08-19T09:00:00.000Z",
    lastActiveAt: "2026-08-19T12:30:00.000Z",
    durationMinutes: 210,
    model: "claude-opus-4",
    client: "anthropic_claude",
    ...overrides,
  };
}

describe("TopSessionsCard", () => {
  it("states the listed sessions' share of the whole timeframe, not of themselves", () => {
    render(
      <TopSessionsCard
        sessions={[makeSession({ cost: 6 })]}
        totalCost={10}
        unsessionedRequests={0}
      />,
    );

    expect(screen.getByText(/60% of/)).toBeInTheDocument();
  });

  it("discloses requests that belong to no session", () => {
    render(
      <TopSessionsCard
        sessions={[makeSession()]}
        totalCost={10}
        unsessionedRequests={12}
      />,
    );

    expect(screen.getByText(/further 12 requests/)).toBeInTheDocument();
  });

  it("renders a duration in hours and minutes", () => {
    render(
      <TopSessionsCard
        sessions={[makeSession({ durationMinutes: 210 })]}
        totalCost={10}
        unsessionedRequests={0}
      />,
    );

    expect(screen.getByText("3h 30m")).toBeInTheDocument();
  });

  it("names a session with no reported client or model rather than leaving cells blank", () => {
    render(
      <TopSessionsCard
        sessions={[makeSession({ client: null, model: null })]}
        totalCost={10}
        unsessionedRequests={0}
      />,
    );

    expect(screen.getAllByText("Not reported")).toHaveLength(2);
  });
});
