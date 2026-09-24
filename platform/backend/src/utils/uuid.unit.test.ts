import { describe, expect, test } from "vitest";
import { isUuid, uuidv5, uuidv7 } from "./uuid";

describe("uuidv7", () => {
  test("produces canonical RFC 9562 version-7 uuids", () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("7"); // version nibble
    expect(["8", "9", "a", "b"]).toContain(id[19]); // variant bits
  });

  test("a same-millisecond burst is strictly increasing", () => {
    // A tight loop mints far more ids per millisecond than the wall clock
    // can distinguish — exactly the tie the generator exists to break.
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  test("ids embed the current unix-ms timestamp", () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const embedded = Number.parseInt(id.replace("-", "").slice(0, 12), 16);
    expect(embedded).toBeGreaterThanOrEqual(before);
    // Same-ms bursts may borrow the next millisecond; allow that headroom.
    expect(embedded).toBeLessThanOrEqual(after + 5);
  });
});

describe("uuidv5", () => {
  const NS = "a7c3e0d2-6b1f-4e8a-9c5d-2f0b8e4a1d63";

  test("produces a canonical version-5 uuid", () => {
    const id = uuidv5("default-org", NS);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("5"); // version nibble
    expect(["8", "9", "a", "b"]).toContain(id[19]); // variant bits
  });

  test("is deterministic for the same name + namespace", () => {
    expect(uuidv5("default-org", NS)).toBe(uuidv5("default-org", NS));
  });

  test("different names yield different uuids", () => {
    expect(uuidv5("org-a", NS)).not.toBe(uuidv5("org-b", NS));
  });

  test("matches the RFC 4122 v5 reference vector (DNS namespace, python.org)", () => {
    // From RFC 4122 §A / widely-published test vectors.
    expect(uuidv5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  test("rejects a non-UUID namespace", () => {
    expect(() => uuidv5("x", "not-a-uuid")).toThrow();
  });
});
