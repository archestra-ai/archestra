import { describe, expect, it } from "vitest";

import {
  hasUnsavedChanges,
  resolveCloseAttempt,
} from "./unsaved-changes-guard-utils";

describe("resolveCloseAttempt", () => {
  it("opens without guarding when the dialog is opening", () => {
    expect(resolveCloseAttempt({ nextOpen: true, isDirty: true })).toBe("open");
  });

  it("closes immediately when closing a clean form", () => {
    expect(resolveCloseAttempt({ nextOpen: false, isDirty: false })).toBe(
      "close",
    );
  });

  it("asks for confirmation when closing a dirty form", () => {
    expect(resolveCloseAttempt({ nextOpen: false, isDirty: true })).toBe(
      "confirm",
    );
  });
});

describe("hasUnsavedChanges", () => {
  it("reports no changes for identical snapshots", () => {
    const snapshot = { name: "Agent", tags: ["a", "b"] };
    expect(
      hasUnsavedChanges(snapshot, { name: "Agent", tags: ["a", "b"] }),
    ).toBe(false);
  });

  it("reports changes when a scalar field differs", () => {
    expect(
      hasUnsavedChanges({ name: "Agent" }, { name: "Agent renamed" }),
    ).toBe(true);
  });

  it("reports changes when an array element differs", () => {
    expect(hasUnsavedChanges({ tags: ["a", "b"] }, { tags: ["a", "c"] })).toBe(
      true,
    );
  });

  it("reports changes for a nested object edit", () => {
    expect(
      hasUnsavedChanges({ config: { port: 8080 } }, { config: { port: 9090 } }),
    ).toBe(true);
  });

  it("treats null, undefined, and empty string as the same empty value", () => {
    expect(hasUnsavedChanges({ description: null }, { description: "" })).toBe(
      false,
    );
    expect(
      hasUnsavedChanges({ description: undefined }, { description: null }),
    ).toBe(false);
    expect(
      hasUnsavedChanges({ description: "" }, { description: undefined }),
    ).toBe(false);
  });

  it("still reports a real edit into a previously empty field", () => {
    expect(
      hasUnsavedChanges({ description: null }, { description: "hi" }),
    ).toBe(true);
  });
});
