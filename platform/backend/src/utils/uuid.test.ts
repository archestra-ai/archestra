import { describe, expect, test } from "vitest";
import { isUuid, uuidv7 } from "./uuid";

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
