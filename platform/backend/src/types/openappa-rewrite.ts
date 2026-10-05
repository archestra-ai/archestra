import { z } from "zod";

export const OPENAPPA_REWRITE_PROTOCOL_VERSION = 1 as const;

export type OpenAppaRewriteProtocolVersion =
  typeof OPENAPPA_REWRITE_PROTOCOL_VERSION;

export const OPENAPPA_REWRITE_DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

export const OPENAPPA_REWRITE_MAX_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const OPENAPPA_REWRITE_TOUCH_SLACK_MS = 60_000;

export const OPENAPPA_REWRITE_DEFAULT_MAX_ENTRIES = 4_096;

export const OPENAPPA_REWRITE_MAX_ENTRIES = 65_536;

export const OPENAPPA_REWRITE_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export const OPENAPPA_REWRITE_MAX_BYTES = 256 * 1024 * 1024;

export const OPENAPPA_REWRITE_MAX_BATCH = 65_536;

export const OPENAPPA_REWRITE_MAX_PAIR_BYTES = 1024 * 1024;

export const OPENAPPA_REWRITE_MAX_HEAD_BYTES = 4 * 1024;

export const OPENAPPA_REWRITE_MAX_KEY_LENGTH = 512;

export const OPENAPPA_REWRITE_MAX_WIRE_LENGTH = 128;

export const OPENAPPA_REWRITE_DEFAULT_SWEEP_BATCH = 64;

export const OPENAPPA_REWRITE_MAX_SWEEP_BATCH = 1_024;

export const OPENAPPA_REWRITE_MAX_FORK_DEPTH = 32;

export const OpenAppaRewriteStatusSchema = z.enum(["live", "expired"]);

export type OpenAppaRewriteStatus = z.infer<typeof OpenAppaRewriteStatusSchema>;

export type OpenAppaRewriteScope = {
  organizationId: string;
  sessionId: string;
  root: string;
  groupId: string;
  epoch: number;
  protocolVersion: OpenAppaRewriteProtocolVersion;
  expiresAt: Date;
};

export type OpenAppaRewritePair = {
  fragmentKey: string;
  original: Buffer;
  rewritten: Buffer;
};

export type OpenAppaRewriteReservation = {
  scope: OpenAppaRewriteScope;
  fragmentKey: string;
  reservationId: string;
  expiresAt: Date;
};

export type OpenAppaRewriteHead = {
  wire: string;
  revision: number;
  state: Buffer;
};

export type OpenAppaRewriteOpenInput = {
  organizationId: string;
  sessionId: string;
  idleTtlMs?: number;
  protocolVersion: OpenAppaRewriteProtocolVersion;
  maxEntries?: number;
  maxBytes?: number;
  now?: Date;
};

export type OpenAppaRewriteExistingInput = {
  organizationId: string;
  sessionId: string;
  protocolVersion: OpenAppaRewriteProtocolVersion;
  now?: Date;
};
