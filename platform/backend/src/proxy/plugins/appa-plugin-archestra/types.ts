export type AppaClientAdapter = {
  readonly id: string;
  matches(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
  }): boolean;
  getNativeSessionId(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
  }): string | undefined;
  classifyToolName(name: string): "gateway" | "local";
  normalizeLocalToolName(name: string): string;
};
