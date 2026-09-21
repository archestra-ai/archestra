import type { AppaPreparedRequest } from "@/openappa/request";
import type { AppaChatSource, OpenAppaSession } from "@/openappa/service";
import type { AppaSessionIdentity } from "@/openappa/wire";

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
   * The client's own question tool. Its results need the same decision
   * guidance as ask_user. Clients without MCP forms may also provide an
   * argument converter to receive ask_user calls through their native tool.
   */
  nativeQuestion?: {
    toolName: string;
    fromAskUser?(args: AskUserArguments): Record<string, unknown>;
  };
  /**
   * Reads the trajectory identity the client itself puts on the wire: the id
   * it keeps stable across a resumed or compacted conversation, so a resume
   * reopens the same OpenAPPA root. A fork or an out-of-band summarizer gets a
   * new id, but the history it replays carries the parent's trajectory stamps,
   * which continue the parent's root instead (`openappa/trajectory-stamp.ts`).
   * Runs before the generic wire-family fallbacks; returning
   * `undefined` defers to them. A request whose native signals contradict
   * each other is refused rather than bound to a trajectory chosen by
   * precedence.
   */
  extractSessionIdentity?(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
  }): AppaSessionIdentity | undefined;
};

/** The arguments of the platform's ask_user tool. */
export type AskUserArguments = {
  question: string;
  /** Short tab label; unvalidated here, as the model wrote it. */
  header?: unknown;
  options: Array<{ label: string; description?: string }>;
  allowMultiple?: boolean;
  remedy_offer_ids?: string[];
};
