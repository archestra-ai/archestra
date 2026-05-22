import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AuditLogDiffView,
  summarizeAuditDiffHints,
} from "./audit-log-diff-view";

/**
 * Contract: AuditLogDiffView — JSON-shaped unified diff with quoted keys,
 * full + / − blocks for creates/deletes, nested and array deltas, quoteKey escaping.
 */

describe("AuditLogDiffView", () => {
  it("renders the empty state when both snapshots are null", () => {
    render(<AuditLogDiffView before={null} after={null} />);
    expect(
      screen.getByText("No tracked changes for this event."),
    ).toBeInTheDocument();
  });

  it("uses a custom empty message when provided", () => {
    render(
      <AuditLogDiffView
        before={null}
        after={null}
        emptyMessage="Custom empty"
      />,
    );
    expect(screen.getByText("Custom empty")).toBeInTheDocument();
  });

  it("renders a full + block when before is null (create event)", () => {
    render(
      <AuditLogDiffView before={null} after={{ name: "Agent A", id: "abc" }} />,
    );

    const added = screen.getAllByRole("listitem");
    expect(added).toHaveLength(2);

    for (const item of added) {
      expect(item).toHaveAttribute("data-diff-kind", "added");
    }

    expect(added[0]).toHaveTextContent(`"name": "Agent A",`);
    expect(added[1]).toHaveTextContent(`"id": "abc"`);
  });

  it("renders a full - block when after is null (delete event)", () => {
    render(
      <AuditLogDiffView
        before={{ name: "Old name", id: "abc" }}
        after={null}
      />,
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
        before={{
          id: "abc",
          name: "Engineering Team Agent",
          description: "Same",
        }}
        after={{ id: "abc", name: "My Agent", description: "Same" }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);

    expect(items[0]).toHaveAttribute("data-diff-kind", "context");
    expect(items[0]).toHaveTextContent(`"id": "abc",`);

    expect(items[1]).toHaveAttribute("data-diff-kind", "removed");
    expect(items[1]).toHaveTextContent(`"name": "Engineering Team Agent",`);

    expect(items[2]).toHaveAttribute("data-diff-kind", "added");
    expect(items[2]).toHaveTextContent(`"name": "My Agent",`);

    expect(items[3]).toHaveAttribute("data-diff-kind", "context");
    expect(items[3]).toHaveTextContent(`"description": "Same"`);
  });

  it("renders nothing when before and after are deeply equal", () => {
    render(
      <AuditLogDiffView
        before={{ id: "abc", tags: ["a", "b"] }}
        after={{ id: "abc", tags: ["a", "b"] }}
      />,
    );

    expect(
      screen.getByText("No field-level differences between the snapshots."),
    ).toBeInTheDocument();
  });

  it("emits added/removed lines for keys that exist on only one side", () => {
    render(
      <AuditLogDiffView
        before={{ id: "abc", legacyFlag: true }}
        after={{ id: "abc", newFlag: false }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const [removed, added] = items;
    expect(removed).toHaveAttribute("data-diff-kind", "removed");
    expect(within(removed).getByText(/"legacyFlag": true/)).toBeInTheDocument();

    expect(added).toHaveAttribute("data-diff-kind", "added");
    expect(within(added).getByText(/"newFlag": false/)).toBeInTheDocument();
  });

  it("emits JSON-shaped output with quoted keys and trailing commas on create", () => {
    render(
      <AuditLogDiffView
        before={null}
        after={{ name: "Agent A", id: "abc", enabled: true }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    // opening `{`, three field lines, closing `}` (all `added`)
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent(/^\{$/);
    expect(items[items.length - 1]).toHaveTextContent(/^\}$/);

    // Trailing commas after each field except the last
    expect(items[1]).toHaveTextContent(`"name": "Agent A",`);
    expect(items[2]).toHaveTextContent(`"id": "abc",`);
    expect(items[3]).toHaveTextContent(`"enabled": true`);
    expect(items[3].textContent).not.toMatch(/true,/);
  });

  it("JSON-escapes keys with special characters via quoteKey", () => {
    render(
      <AuditLogDiffView
        before={null}
        after={{ 'weird "key" with spaces': "value" }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    // The key must be JSON-quoted with embedded quotes escaped as `\"`.
    const fieldLine = items[1];
    expect(fieldLine.textContent).toContain(`"weird \\"key\\" with spaces"`);
    expect(fieldLine.textContent).toContain(`: "value"`);
  });

  it("array diff: insertion at end renders only an added item at that index", () => {
    render(
      <AuditLogDiffView
        before={{ tags: ["a", "b"] }}
        after={{ tags: ["a", "b", "c"] }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    const kinds = items.map((el) => el.getAttribute("data-diff-kind"));
    // Should contain exactly one added (the new tail) and no removed
    expect(kinds.filter((k) => k === "added")).toHaveLength(1);
    expect(kinds.filter((k) => k === "removed")).toHaveLength(0);
    const addedLine = items.find(
      (el) => el.getAttribute("data-diff-kind") === "added",
    );
    expect(addedLine?.textContent).toContain(`"c"`);
  });

  it("array diff: deletion at end renders only a removed item at that index", () => {
    render(
      <AuditLogDiffView
        before={{ tags: ["a", "b", "c"] }}
        after={{ tags: ["a", "b"] }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    const kinds = items.map((el) => el.getAttribute("data-diff-kind"));
    expect(kinds.filter((k) => k === "removed")).toHaveLength(1);
    expect(kinds.filter((k) => k === "added")).toHaveLength(0);
  });

  it("array diff: replacement at a given index renders removed + added on that index only", () => {
    render(
      <AuditLogDiffView
        before={{ tags: ["a", "X", "c"] }}
        after={{ tags: ["a", "Y", "c"] }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    const removed = items.filter(
      (el) => el.getAttribute("data-diff-kind") === "removed",
    );
    const added = items.filter(
      (el) => el.getAttribute("data-diff-kind") === "added",
    );
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].textContent).toContain(`"X"`);
    expect(added[0].textContent).toContain(`"Y"`);
  });

  it("recurses into nested objects and only emits changed leaf keys", () => {
    render(
      <AuditLogDiffView
        before={{
          id: "abc",
          config: { region: "us-east-1", retries: 3 },
        }}
        after={{
          id: "abc",
          config: { region: "us-east-1", retries: 5 },
        }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveAttribute("data-diff-kind", "context");
    expect(items[0]).toHaveTextContent(`"config": {`);
    expect(items[1]).toHaveAttribute("data-diff-kind", "context");
    expect(items[1]).toHaveTextContent(`"region": "us-east-1",`);
    expect(items[2]).toHaveAttribute("data-diff-kind", "removed");
    expect(items[2].textContent).toMatch(/"retries": 3/);
    expect(items[3]).toHaveAttribute("data-diff-kind", "added");
    expect(items[3].textContent).toMatch(/"retries": 5/);
    expect(items[4]).toHaveAttribute("data-diff-kind", "context");
    expect(items[4]).toHaveTextContent("}");
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
