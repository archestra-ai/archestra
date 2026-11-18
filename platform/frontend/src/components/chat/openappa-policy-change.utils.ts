type PolicyChange = {
  stage?: "preview";
  delivery: "revision" | "pull_request";
  before: string;
  after: string;
  diff?: string;
  path?: string;
  revision?: number;
  number?: number;
  url?: string;
  warnings?: string[];
  errors?: string[];
  enforcement?: { enabled: boolean; reason?: string };
  effective?: { error: string | null; batteries: { status: string }[] };
};

export function parsePolicyChange(
  output: unknown,
  validationChange = false,
): PolicyChange | null {
  const value = parsePolicyOutput(output);
  if (!value) return null;
  if (
    validationChange &&
    (value.stage === "preview" || value.before === value.after)
  )
    return null;
  if (
    (value.delivery !== "revision" && value.delivery !== "pull_request") ||
    typeof value.before !== "string" ||
    typeof value.after !== "string"
  )
    return null;
  return value as PolicyChange;
}

export function parsePolicyOutput(
  output: unknown,
): Record<string, unknown> | null {
  let candidate = output;
  if (candidate && typeof candidate === "object") {
    if ("isError" in candidate && candidate.isError === true) return null;
    if ("structuredContent" in candidate) {
      candidate = candidate.structuredContent;
    } else if ("content" in candidate) {
      candidate = candidate.content;
    }
  }
  if (Array.isArray(candidate)) {
    candidate = candidate.find(
      (item) => item && typeof item === "object" && item.type === "text",
    )?.text;
  }
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as Record<string, unknown>;
}
