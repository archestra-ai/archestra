import { beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
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
    expect(stripped.receipts[0]?.runtimeSessionId).toBeUndefined();
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

  test("signs a runtime workspace anchor without changing a v2 receipt", () => {
    const runtimeSessionId = "user:alice|workspace";
    const footer = mintChildTrajectoryReceipt({
      ...BINDING,
      runtimeSessionId,
    });
    const stripped = stripChildTrajectoryReceipts(footer ?? "");
    expect(stripped.receipts[0]?.runtimeSessionId).toBe(runtimeSessionId);
    expect(
      verifyChildTrajectoryReceipt({
        receipt: stripped.receipts[0],
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: BINDING.childNativeId,
      }),
    ).toBe(true);
    expect(
      verifyChildTrajectoryReceipt({
        receipt: {
          ...stripped.receipts[0],
          runtimeSessionId: "user:alice|other",
        },
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
      }),
    ).toBe(false);
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

  test("binds a mapped teammate receipt to its original native conversation", () => {
    const footer = mintChildTrajectoryReceipt({
      ...BINDING,
      nativeConversationId: "native-child-session",
    });
    const [receipt] = stripChildTrajectoryReceipts(footer ?? "").receipts;
    const checks = {
      receipt,
      organizationId: BINDING.organizationId,
      callerId: BINDING.callerId,
      spawnerNativeId: BINDING.spawnerNativeId,
      childNativeId: BINDING.childNativeId,
    };
    expect(receipt.nativeConversationId).toBe("native-child-session");
    expect(
      verifyChildTrajectoryReceipt({
        ...checks,
        nativeConversationId: "native-child-session",
      }),
    ).toBe(true);
    expect(
      verifyChildTrajectoryReceipt({
        ...checks,
        nativeConversationId: "another-child-session",
      }),
    ).toBe(false);
    expect(
      verifyChildTrajectoryReceipt({
        ...checks,
        receipt: { ...receipt, nativeConversationId: "another-child-session" },
      }),
    ).toBe(false);
    const [old] = stripChildTrajectoryReceipts(
      mintChildTrajectoryReceipt(BINDING) ?? "",
    ).receipts;
    expect(verifyChildTrajectoryReceipt({ ...checks, receipt: old })).toBe(
      true,
    );
    expect(
      verifyChildTrajectoryReceipt({
        ...checks,
        receipt: old,
        nativeConversationId: "native-child-session",
      }),
    ).toBe(false);
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

  test.each([
    {},
    { nativeConversationId: "native-conversation" },
    { runtimeSessionId: "user:alice|workspace" },
    {
      runtimeSessionId: "user:alice|workspace",
      nativeConversationId: "native-conversation",
    },
  ])("requires an explicitly expected native identity to be sealed: %j", (anchor) => {
    const [bound] = stripChildTrajectoryReceipts(
      mintChildTrajectoryReceipt({ ...BINDING, ...anchor }) ?? "",
    ).receipts;
    const [early] = stripChildTrajectoryReceipts(
      mintChildTrajectoryReceipt({
        ...BINDING,
        ...anchor,
        childNativeId: undefined,
      }) ?? "",
    ).receipts;
    const scope = {
      organizationId: BINDING.organizationId,
      callerId: BINDING.callerId,
      spawnerNativeId: BINDING.spawnerNativeId,
    };
    // Ownership verification does not claim an unknown native identity.
    expect(verifyChildTrajectoryReceipt({ ...scope, receipt: early })).toBe(
      true,
    );
    expect(verifyChildTrajectoryReceipt({ ...scope, receipt: bound })).toBe(
      true,
    );
    expect(
      verifyChildTrajectoryReceipt({
        ...scope,
        receipt: bound,
        childNativeId: BINDING.childNativeId,
      }),
    ).toBe(true);
    for (const receipt of [bound, early]) {
      expect(
        verifyChildTrajectoryReceipt({
          ...scope,
          receipt,
          childNativeId: "different-native-id",
        }),
      ).toBe(false);
    }
    expect(
      verifyChildTrajectoryReceipt({
        ...scope,
        receipt: early,
        childNativeId: BINDING.childNativeId,
      }),
    ).toBe(false);
  });

  test("signs marker-only bindings without attesting to a later native child id", () => {
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
      }),
    ).toBe(true);
    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: "later-native-id",
      }),
    ).toBe(false);
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

  test("treats a whitespace-only signing secret as no secret", () => {
    const footer = mintChildTrajectoryReceipt(BINDING);
    if (!footer) throw new Error("expected a child trajectory receipt");
    const [receipt] = stripChildTrajectoryReceipts(footer).receipts;

    config.openappa.offerSigningSecret = " \t\n ";
    expect(mintChildTrajectoryReceipt(BINDING)).toBeUndefined();
    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: BINDING.organizationId,
        callerId: BINDING.callerId,
        spawnerNativeId: BINDING.spawnerNativeId,
        childNativeId: BINDING.childNativeId,
      }),
    ).toBe(false);
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
