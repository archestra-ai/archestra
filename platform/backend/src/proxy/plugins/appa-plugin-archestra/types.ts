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

export type AppaMatchContext = {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  requestBody: unknown;
  trustedContext?: AppaTrustedContext;
};

/** Server-minted child identity. `sessionId` is the child; `parentId` is the root. */
export type AppaChildTrajectory = {
  sessionId: string;
  parentId: string;
};

export type AppaClientAdapter = {
  readonly id: string;
  /** Prefix for this client's native spawn/child namespace. */
  readonly trajectoryPrefix: string;
  /** Client signals select tool syntax, not authority; they may be spoofed. */
  matches(context: AppaMatchContext): boolean;
  classifyToolName(name: string): "gateway" | "local";
  normalizeLocalToolName(name: string): string;
  /** True when this local tool starts a delegated child run. */
  isSpawnTool(name: string): boolean;
  /**
   * Identifies child trajectories named in a call's arguments, in the same
   * namespace `bindChildTrajectory` mints, so names_children matches opened
   * children.
   */
  namesChildren(params: { rootId: string; arguments: unknown }): string[];
  /**
   * Bind a delegated child request to a server-minted trajectory. Returns
   * undefined for a root request. Throws when correlation headers are absent,
   * duplicate, reused, or bound to another parent.
   */
  bindChildTrajectory(
    context: AppaMatchContext,
  ): AppaChildTrajectory | undefined;
};
