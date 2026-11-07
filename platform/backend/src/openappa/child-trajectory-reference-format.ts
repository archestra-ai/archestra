import { ApiError } from "@/types/api";

// The short code locates a session, never authorizes it. The digest selects an
// immutable signed binding: a resumed actor can have several native identities.
const REFERENCE =
  /▄█▄▄▄█▄ {2}started subagent ([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}@[A-Za-z0-9_-]{22})(?![A-Za-z0-9_@-])/g;

export function stripChildTrajectoryReferences(
  text: string,
  options: { preserveLineBoundaries?: boolean } = {},
): {
  text: string;
  references: string[];
} {
  const references: string[] = [];
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
  if (/▄█▄▄▄█▄ {2}started subagent [^\r\n]*@/.test(stripped))
    throw new ApiError(400, "OpenAPPA received a malformed child reference");
  return { text: stripped, references };
}
