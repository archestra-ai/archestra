import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AuditLogDiffView,
  summarizeAuditDiffHints,
} from "./audit-log-diff-view";

describe("AuditLogDiffView", () => {
  it("renders the empty state when both snapshots are null", () => {
    render(<AuditLogDiffView prior={null} post={null} />);
    expect(
      screen.getByText("No tracked changes for this event."),
    ).toBeInTheDocument();
  });

  it("uses a custom empty message when provided", () => {
    render(
      <AuditLogDiffView prior={null} post={null} emptyMessage="Custom empty" />,
    );
    expect(screen.getByText("Custom empty")).toBeInTheDocument();
  });

  it("renders a full + block when prior is null (create event)", () => {
    render(
      <AuditLogDiffView prior={null} post={{ name: "Agent A", id: "abc" }} />,
    );

    const added = screen.getAllByRole("listitem");
    expect(added).toHaveLength(2);

    for (const item of added) {
      expect(item).toHaveAttribute("data-diff-kind", "added");
    }

    expect(added[0]).toHaveTextContent(`name: "Agent A"`);
    expect(added[1]).toHaveTextContent(`id: "abc"`);
  });

  it("renders a full - block when post is null (delete event)", () => {
    render(
      <AuditLogDiffView prior={{ name: "Old name", id: "abc" }} post={null} />,
    );

    const removed = screen.getAllByRole("listitem");
    expect(removed).toHaveLength(2);
    for (const item of removed) {
      expect(item).toHaveAttribute("data-diff-kind", "removed");
    }
  });

  it("shows unchanged fields as context and marks changed fields on update", () => {
    render(
      <AuditLogDiffView
        prior={{
          id: "abc",
          name: "Engineering Team Agent",
          description: "Same",
        }}
        post={{ id: "abc", name: "My Agent", description: "Same" }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);

    expect(items[0]).toHaveAttribute("data-diff-kind", "context");
    expect(items[0]).toHaveTextContent(`id: "abc"`);

    expect(items[1]).toHaveAttribute("data-diff-kind", "removed");
    expect(items[1]).toHaveTextContent(`name: "Engineering Team Agent"`);

    expect(items[2]).toHaveAttribute("data-diff-kind", "added");
    expect(items[2]).toHaveTextContent(`name: "My Agent"`);

    expect(items[3]).toHaveAttribute("data-diff-kind", "context");
    expect(items[3]).toHaveTextContent(`description: "Same"`);
  });

  it("renders nothing when prior and post are deeply equal", () => {
    render(
      <AuditLogDiffView
        prior={{ id: "abc", tags: ["a", "b"] }}
        post={{ id: "abc", tags: ["a", "b"] }}
      />,
    );

    expect(
      screen.getByText("No field-level differences between the snapshots."),
    ).toBeInTheDocument();
  });

  it("emits added/removed lines for keys that exist on only one side", () => {
    render(
      <AuditLogDiffView
        prior={{ id: "abc", legacyFlag: true }}
        post={{ id: "abc", newFlag: false }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const [removed, added] = items;
    expect(removed).toHaveAttribute("data-diff-kind", "removed");
    expect(within(removed).getByText(/legacyFlag: true/)).toBeInTheDocument();

    expect(added).toHaveAttribute("data-diff-kind", "added");
    expect(within(added).getByText(/newFlag: false/)).toBeInTheDocument();
  });

  it("recurses into nested objects and only emits changed leaf keys", () => {
    render(
      <AuditLogDiffView
        prior={{
          id: "abc",
          config: { region: "us-east-1", retries: 3 },
        }}
        post={{
          id: "abc",
          config: { region: "us-east-1", retries: 5 },
        }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    // Expect: context "config: {", removed retries, added retries, context "}"
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveAttribute("data-diff-kind", "context");
    expect(items[0]).toHaveTextContent("config: {");
    expect(items[1]).toHaveAttribute("data-diff-kind", "removed");
    expect(items[1]).toHaveTextContent("retries: 3");
    expect(items[2]).toHaveAttribute("data-diff-kind", "added");
    expect(items[2]).toHaveTextContent("retries: 5");
    expect(items[3]).toHaveAttribute("data-diff-kind", "context");
    expect(items[3]).toHaveTextContent("}");
  });
});

describe("summarizeAuditDiffHints", () => {
  it("lists substantive keys that differ", () => {
    expect(
      summarizeAuditDiffHints(
        { name: "a", updatedAt: "t1" },
        { name: "b", updatedAt: "t2" },
      ),
    ).toBe("Changed: name.");
  });

  it("detects metadata-only changes", () => {
    expect(
      summarizeAuditDiffHints(
        { id: "x", updatedAt: "t1" },
        { id: "x", updatedAt: "t2" },
      ),
    ).toContain("timestamp");
  });

  it("summarizes create snapshots", () => {
    expect(
      summarizeAuditDiffHints(null, {
        id: "1",
        name: "N",
      }),
    ).toContain("Created");
  });

  it("summarizes delete snapshots", () => {
    expect(summarizeAuditDiffHints({ id: "1", name: "N" }, null)).toContain(
      "Deleted",
    );
  });
});
