import type { OpenAppaSession } from "@/openappa/service";

export function readHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  // Fastify lowercases production request headers. Keep the fallback for the
  // case-preserving header records accepted by this reusable adapter boundary.
  const value =
    headers[normalizedName] ??
    Object.entries(headers).find(
      ([headerName]) => headerName.toLowerCase() === normalizedName,
    )?.[1];
  // These client-identification signals are single-valued, not authority headers.
  return Array.isArray(value) ? value[0] : value;
}

/** Normalize the model-provided question header for a client's tab UI. */
export function questionHeader(header: unknown, maxLength: number): string {
  const trimmed = typeof header === "string" ? header.trim() : "";
  return trimmed.length > 0
    ? trimmed.slice(0, maxLength).trimEnd()
    : "Question";
}

/**
 * The ruling's headline and reasons, without the sections after them. For a
 * session that cannot make the calls those sections name, so the model does
 * not pass them on as options.
 *
 * The runtime renders a headline, the reasons under `Why:`, and then only
 * sections that name a remedy or a route around the block (`Continue:`,
 * `Alternative:`, `Keep this session unchanged:`, and others). Each section
 * starts with a heading on its own line after a blank line. The cut is at the
 * first such heading other than `Why:`, so a heading the runtime adds later is
 * dropped too, never shown as an option the session cannot take.
 */
export function withoutRemedySections(ruling: string): string {
  const lines = ruling.split("\n");
  const cut = lines.findIndex(
    (line, index) =>
      index > 0 &&
      lines[index - 1] === "" &&
      SECTION_HEADING.test(line) &&
      line !== "Why:",
  );
  return cut === -1 ? ruling : lines.slice(0, cut).join("\n").trimEnd();
}

/** The id as this session's runtime knows it: under its caller's scope. */
export function withCallerScope(session: OpenAppaSession, id: string): string {
  if (!session.caller_id) return id;
  const prefix = `${session.caller_id}|`;
  return session.session_id.startsWith(prefix) && !id.startsWith(prefix)
    ? `${prefix}${id}`
    : id;
}

/** The id as the client knows it: without its caller's scope. */
export function withoutCallerScope(
  session: OpenAppaSession,
  id: string,
): string {
  const prefix = session.caller_id ? `${session.caller_id}|` : undefined;
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** A ruling's section heading: unindented text that ends with a colon. */
const SECTION_HEADING = /^\S.*:$/;
