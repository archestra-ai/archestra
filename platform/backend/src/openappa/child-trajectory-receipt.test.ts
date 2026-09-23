import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import {
  appendChildTrajectoryReceipt,
  mintChildTrajectoryReceipt,
  stripChildTrajectoryReceipts,
  verifyChildTrajectoryReceipt,
} from "./child-trajectory-receipt";

const SECRET = "child-trajectory-test-secret-0123456789";
const BINDING = {
  organizationId: "org-1",
  callerId: "user:alice",
  parentId: "s1:a1",
  childId: "s1:a1:g1",
  childNativeId: "g1",
  spawnerNativeId: "s1",
  spawnCallId: "toolu_spawn",
} as const;

describe("OpenAPPA stateless child trajectory receipts", () => {
  beforeEach(() => {
    config.openappa.offerSigningSecret = SECRET;
  });

  test("round-trips a complete signed binding beside the display marker", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    expect(footer).toMatch(
      /^▄█▄▄▄█▄\n██▄█▄██ {2}started subagent [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}\n\[appa\] child trajectory appact2-[A-Za-z0-9_-]+\.[0-9a-f]{64}\.$/,
    );
    const stripped = stripChildTrajectoryReceipts(
      appendChildTrajectoryReceipt("compacted history", footer ?? ""),
    );

    expect(stripped.text).toBe("compacted history");
    expect(stripped.receipts).toHaveLength(1);
    expect(stripped.receipts[0]).toMatchObject(BINDING);
    expect(
      verifyChildTrajectoryReceipt({
        receipt: stripped.receipts[0],
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: BINDING.childNativeId,
      }),
    ).toBe(true);
  });

  test("removes CRLF separators without leaving a carriage return", () => {
    const footer = mintChildTrajectoryReceipt(BINDING)?.replaceAll(
      "\n",
      "\r\n",
    );
    if (!footer) throw new Error("expected a signed trajectory proof");
    expect(stripChildTrajectoryReceipts(`hello\r\n\r\n${footer}`).text).toBe(
      "hello",
    );
    expect(stripChildTrajectoryReceipts(`${footer}\r\n\r\nhello`).text).toBe(
      "hello",
    );
  });

  test("treats the pretty code as display-only", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    if (!footer) throw new Error("expected a child trajectory receipt");
    const changedDisplay = footer.replace(
      /started subagent [0-9A-HJKMNP-TV-Z-]+/,
      "started subagent DISPLAY-ONLY",
    );
    const [receipt] = stripChildTrajectoryReceipts(changedDisplay).receipts;

    expect(receipt).toBeDefined();
    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: BINDING.childNativeId,
      }),
    ).toBe(true);
  });

  test("rejects a modified proof or parsed binding", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    if (!footer) throw new Error("expected a child trajectory receipt");
    const modifiedProof = footer.replace(
      /([0-9a-f])\.$/,
      (_, last: string) => `${last === "0" ? "1" : "0"}.`,
    );
    const [tampered] = stripChildTrajectoryReceipts(modifiedProof).receipts;
    const [valid] = stripChildTrajectoryReceipts(footer).receipts;
    const verifies = (receipt: typeof valid) =>
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: BINDING.childNativeId,
      });

    expect(verifies(tampered)).toBe(false);
    expect(verifies({ ...valid, parentId: "other-parent" })).toBe(false);
    expect(verifies({ ...valid, spawnCallId: "other-spawn" })).toBe(false);
  });

  test("rejects a proof outside its authenticated scope", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    const [receipt] = stripChildTrajectoryReceipts(footer ?? "").receipts;

    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: BINDING.organizationId,
        callerId: "user:other",
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: BINDING.childNativeId,
      }),
    ).toBe(false);
    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: "other-spawner",
        childNativeId: "other-child",
      }),
    ).toBe(false);
  });

  test("uses the same proof in inline and full carriers", () => {
    const full = mintChildTrajectoryReceipt(BINDING);
    const inline = mintChildTrajectoryReceipt({ ...BINDING, format: "inline" });
    const token = (value: string | undefined) =>
      value?.match(/appact2-[A-Za-z0-9_-]+\.[0-9a-f]{64}/)?.[0];

    expect(token(inline)).toBe(token(full));
    expect(stripChildTrajectoryReceipts(inline ?? "").receipts).toHaveLength(1);
  });

  test("signs marker-only bindings without inventing a native child id", () => {
    const footer = mintChildTrajectoryReceipt({
      ...BINDING,
      childNativeId: undefined,
    });
    const [receipt] = stripChildTrajectoryReceipts(footer ?? "").receipts;

    expect(receipt).not.toHaveProperty("childNativeId");
    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: "later-native-id",
      }),
    ).toBe(true);
  });

  test("does not mint a binding without its stable child id", () => {
    expect(
      mintChildTrajectoryReceipt({ ...BINDING, childId: undefined }),
    ).toBeUndefined();
  });

  test("does not mint without the signing secret", () => {
    config.openappa.offerSigningSecret = "";
    expect(mintChildTrajectoryReceipt(BINDING)).toBeUndefined();
  });

  test("passes benign oversized text through unchanged", () => {
    const large = `start ${"x".repeat(8 * 1024 * 1024)} end`;
    const stripped = stripChildTrajectoryReceipts(large);

    expect(stripped.text).toBe(large);
    expect(stripped.receipts).toHaveLength(0);
  });

  test("rejects an oversized text that carries a proof", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    if (!footer) throw new Error("expected a child trajectory receipt");
    const large = `${"x".repeat(8 * 1024 * 1024)}\n\n${footer}`;

    expect(() => stripChildTrajectoryReceipts(large)).toThrowError(
      /child-trajectory carrier exceeds its limit/,
    );
  });

  test("strips every carrier at the per-site limit", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    if (!footer) throw new Error("expected a child trajectory receipt");
    const stripped = stripChildTrajectoryReceipts(
      Array.from({ length: 64 }, () => footer).join("\n\n"),
    );

    expect(stripped.receipts).toHaveLength(64);
    expect(stripped.text).not.toContain("appact2-");
  });

  test("rejects instead of leaving proofs beyond the per-site limit", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    if (!footer) throw new Error("expected a child trajectory receipt");
    const crowded = Array.from({ length: 65 }, () => footer).join("\n\n");

    expect(() => stripChildTrajectoryReceipts(crowded)).toThrowError(
      /too many child-trajectory carriers/,
    );
  });
});
