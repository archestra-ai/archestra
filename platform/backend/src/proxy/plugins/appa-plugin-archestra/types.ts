import type { AppaPreparedRequest } from "@/openappa/request";
import type { AppaChatSource, OpenAppaSession } from "@/openappa/service";

export const APPA_PLUGIN_TRUSTED_CONTEXT: unique symbol = Symbol(
  "archestra.appa.trusted-context",
);

export type AppaTrustedContext = {
  /** Established by the proxy after authentication and session-root validation. */
  session: OpenAppaSession;
  profileId: string;
  canonicalizeToolName: (name: string) => string;
  /** What the proxy prepared for this request before any adapter saw it. */
  request: AppaPreparedRequest;
  /** Present only for the proxy's loopback Chat call path. */
  chatSource?: AppaChatSource;
};

export type AppaClientAdapter = {
  readonly id: string;
  /** Client signals select tool syntax, not authority; they may be spoofed. */
  matches(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
    trustedContext?: AppaTrustedContext;
  }): boolean;
  classifyToolName(name: string): "gateway" | "local";
  normalizeLocalToolName(name: string): string;
  /**
   * The client's own question tool, for a client that cannot show the
   * platform's ask_user as a form: the model's ask_user call is handed to the
   * client as a call to this tool instead, when the request declares it.
   */
  nativeQuestion?: {
    toolName: string;
    fromAskUser(args: AskUserArguments): Record<string, unknown>;
  };
};

/** The arguments of the platform's ask_user tool. */
export type AskUserArguments = {
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowMultiple?: boolean;
};
