type LogFormat = "json" | "pretty";

function parse(value: string | undefined): LogFormat {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "pretty" || normalized === "json") return normalized;
  if (normalized && normalized.length > 0) {
    console.warn(
      `Unknown ARCHESTRA_LOGGING_FORMAT="${value}", falling back to "json"`,
    );
  }
  return "json";
}

export const LOG_FORMAT: LogFormat = parse(
  process.env.ARCHESTRA_LOGGING_FORMAT,
);
