export type AppaClientAdapter = {
  readonly id: "claude-code" | "codex" | "opencode";
  matches(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
  }): boolean;
  normalizeLocalToolName(name: string): string;
};
