import { ApiError } from "@/types/api";

// The short code locates a session, never authorizes it. The digest selects an
// immutable signed binding: a resumed actor can have several native identities.
const REFERENCE =
  /▄█▄▄▄█▄ {2}started subagent ([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}@[A-Za-z0-9_-]{22})(?![A-Za-z0-9_@-])/g;

export function stripChildTrajectoryReferences(
  text: string,
  options: {
    preserveLineBoundaries?: boolean;
    collectReferences?: boolean;
  } = {},
): {
  text: string;
  references: string[];
} {
  const references: string[] = [];
  if (options.collectReferences === false) {
    // Callee text and nested notifications cannot establish caller identity.
    // Strip them in one pass without applying the caller's proof-count limit.
    const stripped = text.replace(
      new RegExp(
        `((?:\\r?\\n){0,2})${REFERENCE.source}((?:\\r?\\n){0,2})`,
        "g",
      ),
      (_match, lead: string, _reference: string, trail: string) =>
        options.preserveLineBoundaries &&
        (lead === "\n" || lead === "\r\n") &&
        trail
          ? lead
          : "",
    );
    return { text: defangChildReferenceText(stripped), references };
  }
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) {
    if (text.includes("started subagent"))
      throw new ApiError(400, "OpenAPPA child reference exceeds its limit");
    return { text, references };
  }
  let stripped = text;
  const matches = [...text.matchAll(REFERENCE)];
  if (matches.length > 64)
    throw new ApiError(400, "OpenAPPA received too many child references");
  for (const match of matches.reverse()) {
    references.unshift(match[1]);
    const start = match.index;
    const end = start + match[0].length;
    const lead = /(?:\r?\n){0,2}$/.exec(stripped.slice(0, start))?.[0] ?? "";
    const trail = /^(?:\r?\n){0,2}/.exec(stripped.slice(end))?.[0] ?? "";
    const boundary =
      options.preserveLineBoundaries &&
      (lead === "\n" || lead === "\r\n") &&
      trail
        ? lead
        : "";
    stripped =
      stripped.slice(0, start - lead.length) +
      boundary +
      stripped.slice(end + trail.length);
  }
  // Near-matches can be quoted by any tool or model. They are display text,
  // never identity evidence; do not let them poison every replay of a chat.
  // Exact references still require the retained signed binding when resolved.
  stripped = defangChildReferenceText(stripped);
  return { text: stripped, references };
}

function defangChildReferenceText(text: string): string {
  // Legacy signed receipts use the same banner without "@". Leave those
  // intact for their own verifier. Scan each line once, including long lines.
  return text
    .split("\n")
    .map((line) =>
      line.includes("@")
        ? line.replaceAll(
            "▄█▄▄▄█▄  started subagent",
            "[quoted child reference]",
          )
        : line,
    )
    .join("\n");
}
