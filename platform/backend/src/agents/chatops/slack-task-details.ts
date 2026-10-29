/** Bounded display copy only: never pass these values back to tool execution. */
export function toolArgumentsDetail(input: unknown): string | undefined {
  if (input == null) return undefined;
  const budget = { remaining: 100 };
  const safe = redactValue({ value: input, depth: 0, budget });
  const serialized = JSON.stringify(safe);
  return serialized === "{}"
    ? undefined
    : limitTaskText(`Arguments: ${serialized}`);
}

/** Slack task titles, details and output are each limited to 256 characters. */
export function slackTaskText(raw: string): string {
  if (raw.length <= SCAN_LIMIT && /^\s*[[{]/.test(raw)) {
    try {
      return limitTaskText(
        JSON.stringify(
          redactValue({
            value: JSON.parse(raw),
            depth: 0,
            budget: { remaining: 100 },
          }),
        ),
      );
    } catch {
      // Error prose and partial JSON use the text rules below.
    }
  }
  return limitTaskText(redactText(raw));
}

// === Internal helpers ===

const REDACTED = "[redacted]";
const OMITTED = "[truncated]";
const SCAN_LIMIT = 4_096;
const SENSITIVE_FIELD =
  /password|passwd|passphrase|secret|token|credential|authorization|cookie|apikey|privatekey|accesskey|signingkey|runtimeproof|^auth$|^headers?$/i;

function limitTaskText(raw: string): string {
  const safe = raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (safe.length <= 256) return safe;
  let end = 255;
  // Keep Unicode code points and Slack entities intact at the boundary.
  if (/[\uD800-\uDBFF]/.test(safe.charAt(end - 1))) end--;
  const lastAmpersand = safe.lastIndexOf("&", end - 1);
  if (lastAmpersand >= 0 && !safe.slice(lastAmpersand, end).includes(";")) {
    end = lastAmpersand;
  }
  return `${safe.slice(0, end)}…`;
}

function sensitiveField(name: string): boolean {
  return SENSITIVE_FIELD.test(name.replace(/[^a-z0-9]/gi, ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactValue(params: {
  value: unknown;
  depth: number;
  budget: { remaining: number };
}): unknown {
  const { value, depth, budget } = params;
  if (--budget.remaining < 0 || depth > 4) return OMITTED;
  if (typeof value === "string") {
    // Nested JSON text (including run_tool args) must follow the same field
    // rules as objects. Oversized strings are withheld rather than cut inside
    // a credential or an unfinished sensitive assignment.
    if (value.length > SCAN_LIMIT) return OMITTED;
    if (/^\s*[[{]/.test(value)) {
      try {
        return redactValue({
          value: JSON.parse(value),
          depth: depth + 1,
          budget,
        });
      } catch {
        // Ordinary prose or invalid JSON still gets text redaction below.
      }
    }
    return redactText(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 10)
      .map((item) => redactValue({ value: item, depth: depth + 1, budget }));
    if (value.length > 10) items.push(OMITTED);
    return items;
  }
  if (isRecord(value)) {
    // Catalog environments and name/value credential lists carry a secret
    // under an innocuous `value` key. Do not invoke getters or toJSON hooks.
    const namedSecret = ["name", "key"].some((key) => {
      const name = Object.getOwnPropertyDescriptor(value, key)?.value;
      return typeof name === "string" && sensitiveField(name);
    });
    const secretEntry =
      Object.getOwnPropertyDescriptor(value, "type")?.value === "secret" ||
      namedSecret;
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count++ >= 20 || budget.remaining <= 0) {
        result[OMITTED] = OMITTED;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      result[redactText(key)] =
        sensitiveField(key) || (secretEntry && key === "value")
          ? REDACTED
          : !descriptor || !("value" in descriptor)
            ? OMITTED
            : redactValue({
                value: descriptor.value,
                depth: depth + 1,
                budget,
              });
    }
    return result;
  }
  return typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : OMITTED;
}

function redactText(raw: string): string {
  if (raw.length > SCAN_LIMIT) return OMITTED;
  return (
    raw
      .replace(/-----BEGIN [\s\S]*?(?:-----END [^-]+-----|$)/g, REDACTED)
      // URLs can carry credentials in userinfo, query parameters or fragments.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted URL]")
      .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, REDACTED)
      // Assignments in error prose, JSON, shell commands and header dumps.
      .replace(
        /(["']?[\w.-]*(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|headers?|api[_-]?key|private[_-]?key|access[_-]?key|runtime[_-]?proof|\bauth)[\w.-]*["']?\s*[:=]\s*)[\s\S]*/i,
        `$1${REDACTED}`,
      )
      .replace(
        /((?:--?(?:password|token|api-key|header)|\bpassword)\s+)[\s\S]*/i,
        `$1${REDACTED}`,
      )
      .replace(/\b(?:xox[baprs]-|sk-|gh[opusr]_|github_pat_)[\w-]+/g, REDACTED)
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
      .replace(/\bey[\w-]+\.[\w-]+\.[\w-]+\b/g, REDACTED)
      .replace(/[A-Za-z0-9+/_=-]{32,}/g, (value) =>
        // Long lower-case tool names are ordinary display text.
        /^[a-z_]+$/.test(value) ? value : REDACTED,
      )
  );
}
