import { timingSafeEqual } from "node:crypto";

export function controlEchoMatches(
  stored: string,
  echoed: string,
): "match" | "mismatch" {
  if (sameUtf8(stored, echoed)) return "match";
  const body = codexControlEchoBody(echoed);
  return body !== undefined && sameUtf8(stored, body) ? "match" : "mismatch";
}

const CODEX_CONTROL_ECHO_PREFIX =
  /^Wall time: [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n/;

function codexControlEchoBody(echoed: string): string | undefined {
  const prefix = CODEX_CONTROL_ECHO_PREFIX.exec(echoed);
  if (!prefix) return undefined;
  return echoed.slice(prefix[0].length);
}

function sameUtf8(stored: string, echoed: string): boolean {
  const actual = Buffer.from(echoed);
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
