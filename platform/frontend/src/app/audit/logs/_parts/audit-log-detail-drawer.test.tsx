import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { AuditLogDetailDrawer } from "./audit-log-detail-drawer";

/**
 * Contract: AuditLogDetailDrawer — names the event and its outcome, opens on
 * the changes when there are snapshots, copies IDs and the event link, and
 * steps through the table's rows.
 */

// navigator.clipboard is not available in jsdom; mock it.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
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
    impersonatedBy: null,
    impersonatedByEmail: null,
    action: "agent.updated",
    outcome: "success",
    resourceType: "agent",
    resourceId: "agent-123",
    resourceName: null,
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

const SHARE_URL = "https://app.example.com/audit/logs?event=evt-1";

function renderDrawer(
  event: AuditLog | null,
  { events = event ? [event] : [] }: { events?: AuditLog[] } = {},
) {
  const onClose = vi.fn();
  const onOpenEvent = vi.fn();
  render(
    <AuditLogDetailDrawer
      event={event}
      shareUrl={SHARE_URL}
      onClose={onClose}
      events={events}
      onOpenEvent={onOpenEvent}
    />,
  );
  return { onClose, onOpenEvent };
}

async function openOverview() {
  await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
}

describe("AuditLogDetailDrawer", () => {
  it("renders nothing while closed", () => {
    renderDrawer(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("titles the drawer with the human action label and the outcome", () => {
    renderDrawer(makeEvent({ action: "agent.created", outcome: "denied" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Agent created")).toBeInTheDocument();
    expect(within(dialog).getByText("Denied")).toBeInTheDocument();
    expect(within(dialog).queryByText("agent.created")).not.toBeInTheDocument();
  });

  it("opens on Changes when the event has snapshots, else on Overview", () => {
    const { unmount } = render(
      <AuditLogDetailDrawer
        event={makeEvent()}
        shareUrl={SHARE_URL}
        onClose={vi.fn()}
        events={[]}
        onOpenEvent={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: /Changes/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    unmount();
    renderDrawer(makeEvent({ before: null, after: null }));
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("names the actor type for machine actors", async () => {
    renderDrawer(
      makeEvent({ actorType: "api_key", before: null, after: null }),
    );
    expect(screen.getByText("API key")).toBeInTheDocument();
  });

  it("shows the resource name and copies its ID", async () => {
    renderDrawer(makeEvent({ resourceName: "Support Agent" }));
    await openOverview();
    expect(screen.getAllByText("Support Agent").length).toBeGreaterThan(0);
    const id = screen.getByText("agent-123");
    await userEvent.click(
      within(id.parentElement as HTMLElement).getByRole("button", {
        name: /Copy to clipboard/i,
      }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("agent-123");
  });

  it("falls back to the snapshot name for rows without resource_name", () => {
    renderDrawer(
      makeEvent({
        resourceName: null,
        before: { name: "Legacy Before" },
        after: { name: "Legacy After" },
      }),
    );
    expect(
      screen.getByText("Legacy After", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("shows and copies the request ID only when there is one", async () => {
    renderDrawer(makeEvent({ requestId: null, before: null, after: null }));
    expect(screen.queryByText("Request ID")).not.toBeInTheDocument();
  });

  it("copies the request ID", async () => {
    renderDrawer(
      makeEvent({ requestId: "req-copy-me", before: null, after: null }),
    );
    const id = screen.getByText("req-copy-me");
    await userEvent.click(
      within(id.parentElement as HTMLElement).getByRole("button", {
        name: /Copy to clipboard/i,
      }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("req-copy-me");
  });

  it("copies the shareable event link from the header", async () => {
    renderDrawer(makeEvent());
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SHARE_URL);
  });

  it("steps through the table's rows with the buttons and j/k", async () => {
    const first = makeEvent({ id: "evt-1" });
    const second = makeEvent({ id: "evt-2", action: "agent.deleted" });
    const third = makeEvent({ id: "evt-3", action: "agent.created" });
    const { onOpenEvent } = renderDrawer(second, {
      events: [first, second, third],
    });
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next event" }));
    expect(onOpenEvent).toHaveBeenLastCalledWith(third);
    await userEvent.keyboard("k");
    expect(onOpenEvent).toHaveBeenLastCalledWith(first);
  });
});
