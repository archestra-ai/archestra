import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { OpenAppaSessionModel } from "@/models";
import { openappaActor } from "./actor";
import {
  appendSessionReceipt,
  formatSessionReceipt,
  mintReceiptCode,
  stripSessionReceipts,
} from "./session-token";
import {
  appendSessionReceiptToResponse,
  sessionReceiptEvidence,
  stripSessionReceiptsFromRequest,
} from "./wire";

const secret = "test-receipt-secret-with-32-characters";
const organizationId = "org-receipt";
const callerId = "user:alice";
const sessionId = "user:alice|session-1";
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/;
const MARK_TOP = "▄█▄▄▄█▄";
const MARK_BOTTOM = "██▄█▄██";

async function started(params: {
  sessionId: string;
  callerId?: string;
  receiptToken?: string;
}) {
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(params.sessionId),
    root: openappaActor(params.sessionId),
    organizationId,
    callerId: params.callerId ?? callerId,
    sessionId: params.sessionId,
    receiptToken: params.receiptToken,
    startDecision: { decision: "ack" },
  });
}

describe("session receipt minting", () => {
  test("strips CRLF receipts and their transport separators", () => {
    const code = "ABC-1234";
    const marker = formatSessionReceipt(code).replaceAll("\n", "\r\n");
    expect(stripSessionReceipts(`${marker}\r\n\r\nhello`)).toEqual({
      text: "hello",
      codes: [code],
    });
    expect(stripSessionReceipts(`hello\r\n\r\n${marker}`)).toEqual({
      text: "hello",
      codes: [code],
    });
  });

  test("mints an opaque Crockford code without a signing key", () => {
    const codes = new Set(Array.from({ length: 16 }, () => mintReceiptCode()));
    expect(codes.size).toBeGreaterThan(1);
    for (const code of codes) {
      expect(code).toMatch(CROCKFORD);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });
});

describe("session receipt storage", () => {
  test("assigns a token once without a signing key and returns it on later calls", async () => {
    config.openappa.offerSigningSecret = "";
    await started({ sessionId });
    const first = await OpenAppaSessionModel.ensureReceiptToken({
      organizationId,
      sessionId,
    });
    const second = await OpenAppaSessionModel.ensureReceiptToken({
      organizationId,
      sessionId,
    });
    expect(first?.token).toMatch(CROCKFORD);
    expect(first?.receiptIssuedAt).toBeNull();
    expect(second?.token).toBe(first?.token);
    expect(
      await OpenAppaSessionModel.receiptTokenOwner({
        organizationId,
        token: first?.token ?? "",
      }),
    ).toEqual({ sessionId, callerId });
  });

  test("reuses a previously stored receipt code", async () => {
    config.openappa.offerSigningSecret = "";
    const legacy = legacyHmacReceiptCode();
    await started({ sessionId, receiptToken: legacy });
    const assigned = await OpenAppaSessionModel.ensureReceiptToken({
      organizationId,
      sessionId,
    });
    expect(assigned?.token).toBe(legacy);
    expect(
      await OpenAppaSessionModel.receiptTokenOwner({
        organizationId,
        token: legacy,
      }),
    ).toEqual({ sessionId, callerId });
    const text = appendSessionReceipt("hello", legacy);
    const codes = stripSessionReceiptsFromRequest({
      family: "anthropic:messages",
      body: { messages: [{ role: "assistant", content: text }] },
    });
    expect(
      await sessionReceiptEvidence({ organizationId, callerId, codes }),
    ).toEqual(["session-1"]);
  });

  test("retries a stored collision and then assigns a new code", async () => {
    const colliding = "user:alice|colliding";
    const taken = "AAA-AAAA";
    const fresh = "BBB-BBBB";
    await started({ sessionId: colliding });
    await started({
      sessionId: "user:alice|holder",
      receiptToken: taken,
    });
    const codes = [taken, fresh];
    const assigned = await OpenAppaSessionModel.ensureReceiptToken({
      organizationId,
      sessionId: colliding,
      mint: () => codes.shift() ?? "CCC-CCCC",
    });
    expect(assigned?.token).toBe(fresh);
  });

  test("gives up after three colliding receipt codes", async () => {
    const colliding = "user:alice|colliding";
    const taken = ["AAA-AAAA", "BBB-BBBB", "CCC-CCCC"];
    await started({ sessionId: colliding });
    for (const [index, token] of taken.entries()) {
      await started({
        sessionId: `user:alice|holder-${index}`,
        receiptToken: token,
      });
    }
    const codes = [...taken];
    expect(
      await OpenAppaSessionModel.ensureReceiptToken({
        organizationId,
        sessionId: colliding,
        mint: () => codes.shift() ?? "DDD-DDDD",
      }),
    ).toBeNull();
  });

  test("concurrent assignment persists one token", async () => {
    await started({ sessionId });
    const [first, second] = await Promise.all([
      OpenAppaSessionModel.ensureReceiptToken({ organizationId, sessionId }),
      OpenAppaSessionModel.ensureReceiptToken({ organizationId, sessionId }),
    ]);
    expect(first?.token).toMatch(CROCKFORD);
    expect(second?.token).toBe(first?.token);
    expect(
      await OpenAppaSessionModel.receiptTokenOwner({
        organizationId,
        token: first?.token ?? "",
      }),
    ).toEqual({ sessionId, callerId });
  });
});

describe("session receipt restore", () => {
  test("mint, append, restore round-trip looks up the owning session", async () => {
    await started({ sessionId });
    const code = await OpenAppaSessionModel.ensureReceiptToken({
      organizationId,
      sessionId,
    });
    expect(code?.token).toBeTruthy();
    const text = appendSessionReceipt("hello", code?.token ?? "");
    const stripped = stripSessionReceipts(text);
    expect(stripped).toEqual({ text: "hello", codes: [code?.token] });
    const body = { messages: [{ role: "assistant", content: text }] };
    const codes = stripSessionReceiptsFromRequest({
      family: "anthropic:messages",
      body,
    });
    expect(
      await sessionReceiptEvidence({ organizationId, callerId, codes }),
    ).toEqual(["session-1"]);
  });

  test("strips every token in a site and ignores unknown or foreign codes", async () => {
    const own = "AAA-AAAA";
    const other = "BBB-BBBB";
    const unknown = "CCC-CCCC";
    await started({ sessionId, receiptToken: own });
    await started({
      sessionId: "user:mallory|foreign",
      callerId: "user:mallory",
      receiptToken: other,
    });
    const text = `keep${formatSessionReceipt(own)}${formatSessionReceipt(other)}${formatSessionReceipt(unknown)}`;
    const restored = stripSessionReceipts(text);
    expect(restored.text).toBe("keep");
    expect(restored.codes).toEqual([own, other, unknown]);
    const body = { messages: [{ role: "assistant", content: text }] };
    const codes = stripSessionReceiptsFromRequest({
      family: "openai:chatCompletions",
      body,
    });
    expect(
      await sessionReceiptEvidence({ organizationId, callerId, codes }),
    ).toEqual(["session-1"]);
  });

  test("puts the session label on the bottom glyph line", () => {
    expect(formatSessionReceipt("AAA-AAAA")).toBe(
      `${MARK_TOP}\n${MARK_BOTTOM}  protected session AAA-AAAA`,
    );
  });

  test("strips the previous top-line label layout", () => {
    const legacy = `${MARK_TOP}  protected session AAA-AAAA\n${MARK_BOTTOM}`;
    expect(stripSessionReceipts(`keep${legacy}`)).toEqual({
      text: "keep",
      codes: ["AAA-AAAA"],
    });
  });

  test("near-miss wording and marks are not receipts", () => {
    const code = "XK7-Q2M9";
    const misses = [
      `${MARK_TOP}\n${MARK_BOTTOM}  protected sessions ${code}`,
      `${MARK_TOP}\n${MARK_BOTTOM}  guarded session ${code}`,
      `${MARK_TOP}\n▄▄▄▄▄▄▄  protected session ${code}`,
      `▄▄▄▄▄▄▄\n${MARK_BOTTOM}  protected session ${code}`,
      `${MARK_TOP}\n${MARK_BOTTOM} protected session ${code}`,
      `${MARK_TOP}\n${MARK_BOTTOM}  protected session  ${code}`,
      `${MARK_TOP}\n${MARK_BOTTOM}  protected session xk7-q2m9`,
      `${MARK_TOP}\n${MARK_BOTTOM}  protected session ILO-UXYZ`,
      `<!-- appa-context-v1:broken -->`,
    ];
    for (const miss of misses) {
      expect(stripSessionReceipts(`text\n\n${miss}`)).toEqual({
        text: `text\n\n${miss}`,
        codes: [],
      });
    }
  });

  test("scan bounds cap matches per site and skip oversized text", () => {
    const block = formatSessionReceipt("AAA-AAAA");
    const many = `lead${block.repeat(65)}`;
    const stripped = stripSessionReceipts(many);
    expect(stripped.codes).toHaveLength(64);
    expect(stripped.text.startsWith("lead")).toBe(true);
    expect(stripSessionReceipts(stripped.text).codes).toEqual(["AAA-AAAA"]);

    const oversized = `${"x".repeat(8 * 1024 * 1024 + 1)}${block}`;
    expect(stripSessionReceipts(oversized)).toEqual({
      text: oversized,
      codes: [],
    });
  });

  test.each([
    {
      family: "anthropic:messages" as const,
      response: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      texts: (response: { content: Array<{ text: string }> }) =>
        response.content.map((part) => part.text),
    },
    {
      family: "openai:chatCompletions" as const,
      response: {
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
              ],
            },
          },
        ],
      },
      texts: (response: {
        choices: Array<{ message: { content: Array<{ text: string }> } }>;
      }) => response.choices[0].message.content.map((part) => part.text),
    },
    {
      family: "openai:responses" as const,
      response: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "first" },
              { type: "output_text", text: "second" },
            ],
          },
        ],
      },
      texts: (response: {
        output: Array<{ content: Array<{ text: string }> }>;
      }) => response.output[0].content.map((part) => part.text),
    },
  ])("prepends one receipt to the first non-empty $family text part", ({
    family,
    response,
    texts,
  }) => {
    const code = "XK7-Q2M9";
    expect(appendSessionReceiptToResponse({ family, response, code })).toBe(
      true,
    );
    expect(texts(response as never)).toEqual([
      appendSessionReceipt("first", code),
      "second",
    ]);
  });
});

function legacyHmacReceiptCode(): string {
  const digest = createHmac("sha256", secret)
    .update(
      `appa-session-receipt-v1\n${organizationId}\n${callerId}\n${sessionId}`,
    )
    .digest();
  let bits = 0n;
  for (let index = 0; index < 5; index++) {
    bits = (bits << 8n) | BigInt(digest[index] ?? 0);
  }
  bits >>= 5n;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const chars: string[] = [];
  for (let index = 0; index < 7; index++) {
    chars.push(alphabet[Number(bits & 31n)] ?? "0");
    bits >>= 5n;
  }
  const code = chars.reverse().join("");
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
