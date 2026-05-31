import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AuditLogDiffView,
  computeDiffLines,
  summarizeAuditDiffHints,
} from "./audit-log-diff-view";

describe("computeDiffLines", () => {
  it("returns [] when both snapshots are null", () => {
    expect(computeDiffLines(null, null)).toEqual([]);
  });

  it("returns all-context lines when snapshots are deeply equal", () => {
    const lines = computeDiffLines(
      { id: "abc", tags: ["a", "b"] },
      { id: "abc", tags: ["a", "b"] },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("full + block for create: all lines added, field text present", () => {
    const lines = computeDiffLines(null, { name: "Agent A", id: "abc" });
    expect(lines.every((l) => l.kind === "added")).toBe(true);
    const texts = lines.map((l) => l.text);
    expect(texts.some((t) => t.includes('"name": "Agent A"'))).toBe(true);
    expect(texts.some((t) => t.includes('"id": "abc"'))).toBe(true);
  });

  it("full - block for delete: all lines removed", () => {
    const lines = computeDiffLines({ name: "Old name", id: "abc" }, null);
    expect(lines.every((l) => l.kind === "removed")).toBe(true);
  });

  it("update: unchanged fields context, changed field removed+added", () => {
    const lines = computeDiffLines(
      { id: "abc", name: "Engineering Team Agent", description: "Same" },
      { id: "abc", name: "My Agent", description: "Same" },
    );
    const idLine = lines.find((l) => l.text.includes('"id"'));
    const removedName = lines.find(
      (l) => l.kind === "removed" && l.text.includes('"name"'),
    );
    const addedName = lines.find(
      (l) => l.kind === "added" && l.text.includes('"name"'),
    );
    const descLine = lines.find((l) => l.text.includes('"description"'));

    expect(idLine?.kind).toBe("context");
    expect(removedName?.text).toContain('"Engineering Team Agent"');
    expect(addedName?.text).toContain('"My Agent"');
    expect(descLine?.kind).toBe("context");
  });

  it("keys only on one side: one removed and one added line", () => {
    const lines = computeDiffLines(
      { id: "abc", legacyFlag: true },
      { id: "abc", newFlag: false },
    );
    const removed = lines.filter((l) => l.kind === "removed");
    const added = lines.filter((l) => l.kind === "added");
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].text).toMatch(/"legacyFlag": true/);
    expect(added[0].text).toMatch(/"newFlag": false/);
  });

  it("JSON-shaped: quoted keys with trailing commas on all but the last field", () => {
    const lines = computeDiffLines(null, {
      name: "Agent A",
      id: "abc",
      enabled: true,
    });
    const nameLine = lines.find((l) => l.text.includes('"name"'));
    const idLine = lines.find((l) => l.text.includes('"id"'));
    const enabledLine = lines.find((l) => l.text.includes('"enabled"'));
    expect(nameLine?.text).toBe('"name": "Agent A",');
    expect(idLine?.text).toBe('"id": "abc",');
    expect(enabledLine?.text).toBe('"enabled": true');
  });

  it("JSON-escapes keys with special characters", () => {
    const lines = computeDiffLines(null, {
      'weird "key" with spaces': "value",
    });
    const fieldLine = lines.find((l) => l.text.includes("weird"));
    expect(fieldLine?.text).toContain('"weird \\"key\\" with spaces"');
    expect(fieldLine?.text).toContain(': "value"');
  });

  it("array diff: insertion at end emits exactly one added line", () => {
    const lines = computeDiffLines(
      { tags: ["a", "b"] },
      { tags: ["a", "b", "c"] },
    );
    const added = lines.filter((l) => l.kind === "added");
    const removed = lines.filter((l) => l.kind === "removed");
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(0);
    expect(added[0].text).toContain('"c"');
  });

  it("array diff: deletion at end emits exactly one removed line", () => {
    const lines = computeDiffLines(
      { tags: ["a", "b", "c"] },
      { tags: ["a", "b"] },
    );
    const removed = lines.filter((l) => l.kind === "removed");
    const added = lines.filter((l) => l.kind === "added");
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(0);
  });

  it("array diff: replacement emits one removed and one added at that index", () => {
    const lines = computeDiffLines(
      { tags: ["a", "X", "c"] },
      { tags: ["a", "Y", "c"] },
    );
    const removed = lines.filter((l) => l.kind === "removed");
    const added = lines.filter((l) => l.kind === "added");
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].text).toContain('"X"');
    expect(added[0].text).toContain('"Y"');
  });

  it("recurses into nested objects and only emits changed leaf keys", () => {
    const lines = computeDiffLines(
      { id: "abc", config: { region: "us-east-1", retries: 3 } },
      { id: "abc", config: { region: "us-east-1", retries: 5 } },
    );
    const regionLine = lines.find((l) => l.text.includes('"region"'));
    const removedRetries = lines.find(
      (l) => l.kind === "removed" && l.text.includes('"retries"'),
    );
    const addedRetries = lines.find(
      (l) => l.kind === "added" && l.text.includes('"retries"'),
    );
    expect(regionLine?.kind).toBe("context");
    expect(removedRetries?.text).toMatch(/"retries": 3/);
    expect(addedRetries?.text).toMatch(/"retries": 5/);
  });
});

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

  it("renders the empty state when snapshots are deeply equal", () => {
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

  it("renders a diff list when snapshots differ", () => {
    render(
      <AuditLogDiffView before={{ name: "Old" }} after={{ name: "New" }} />,
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
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
