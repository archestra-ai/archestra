import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { AuditLogDetailDialog } from "./audit-log-detail-dialog";

/**
 * Contract: AuditLogDetailDialog — surfaces outcome badge, actor type,
 * occurred_at vs created_at, and request_id copy button.
 */

// navigator.clipboard is not available in jsdom; mock it.
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
});

function makeEvent(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "evt-1",
    eventSequence: 1,
    organizationId: "org-1",
    actorId: "user-1",
    actorType: "user",
    actorName: "Ada Lovelace",
    actorEmail: "ada@example.com",
    action: "agent.updated",
    outcome: "success",
    resourceType: "agent",
    resourceId: "agent-123",
    before: { name: "Old" },
    after: { name: "New" },
    httpMethod: "PATCH",
    httpPath: "/api/agents/agent-123",
    httpRoute: "/api/agents/:id",
    httpStatus: 200,
    requestId: null,
    sourceIp: "10.0.0.1",
    userAgent: "Mozilla/5.0",
    occurredAt: new Date("2026-05-13T10:00:00Z").toISOString(),
    createdAt: new Date("2026-05-13T10:00:00Z").toISOString(),
    ...overrides,
  };
}

function renderDialog(
  event: AuditLog | null,
  shareUrl = "https://app.example.com/audit/logs?event=evt-1",
) {
  const onClose = vi.fn();
  render(
    <AuditLogDetailDialog
      event={event}
      shareUrl={shareUrl}
      onClose={onClose}
    />,
  );
  return { onClose };
}

/**
 * The dialog title has its own copy-link button with the same accessible
 * name, so scope request-ID copy button queries to the "Request ID" row.
 */
function queryRequestIdCopyButton() {
  const row = screen.queryByText("Request ID:")?.parentElement;
  if (!row) return null;
  return within(row).queryByRole("button", { name: /Copy to clipboard/i });
}

describe("AuditLogDetailDialog", () => {
  it("renders nothing (closed) when event is null", () => {
    renderDialog(null);
    expect(
      screen.queryByRole("heading", { name: /Event details/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the outcome badge for a success event", () => {
    renderDialog(makeEvent({ outcome: "success" }));
    expect(screen.getByText("Success")).toBeInTheDocument();
  });

  it("shows the outcome badge for a denied event", () => {
    renderDialog(makeEvent({ outcome: "denied" }));
    expect(screen.getByText("Denied")).toBeInTheDocument();
  });

  it("shows the outcome badge for a failure event", () => {
    renderDialog(makeEvent({ outcome: "failure" }));
    expect(screen.getByText("Failure")).toBeInTheDocument();
  });

  it("shows actor type label below the actor name", () => {
    renderDialog(makeEvent({ actorType: "api_key" }));
    expect(screen.getByText("API key")).toBeInTheDocument();
  });

  it("shows 'SSO' actor type for SSO callback events", () => {
    renderDialog(makeEvent({ actorType: "sso" }));
    expect(screen.getByText("SSO")).toBeInTheDocument();
  });

  it("does not render a request-ID copy button when requestId is null", () => {
    renderDialog(makeEvent({ requestId: null }));
    expect(queryRequestIdCopyButton()).not.toBeInTheDocument();
  });

  it("renders a copy button and the request ID when requestId is set", () => {
    renderDialog(makeEvent({ requestId: "req-abc-123" }));
    expect(screen.getByText("req-abc-123")).toBeInTheDocument();
    expect(queryRequestIdCopyButton()).toBeInTheDocument();
  });

  it("copies the request ID to clipboard when copy button is clicked", async () => {
    renderDialog(makeEvent({ requestId: "req-copy-me" }));
    const copyButton = queryRequestIdCopyButton();
    if (!copyButton) throw new Error("request-ID copy button not rendered");
    await userEvent.click(copyButton);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("req-copy-me");
  });

  it("copies the shareable event URL from the copy-link button in the dialog title", async () => {
    const shareUrl = "https://app.example.com/audit/logs?event=evt-1";
    renderDialog(makeEvent({ requestId: null }), shareUrl);
    // With requestId null the title copy-link button is the only copy button.
    await userEvent.click(
      screen.getByRole("button", { name: /Copy to clipboard/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(shareUrl);
  });

  it("shows only the occurred timestamp, never a separate recorded one", () => {
    renderDialog(
      makeEvent({
        occurredAt: new Date("2026-05-13T10:00:00Z").toISOString(),
        createdAt: new Date("2026-05-13T10:00:05Z").toISOString(),
      }),
    );
    expect(screen.queryByText("Recorded")).not.toBeInTheDocument();
    expect(screen.queryByText(/same as occurred/i)).not.toBeInTheDocument();
  });

  it("shows the human action label, not the raw dotted name", () => {
    renderDialog(makeEvent({ action: "agent.created" }));
    expect(screen.getByText("Agent created")).toBeInTheDocument();
    expect(screen.queryByText("agent.created")).not.toBeInTheDocument();
  });
});
