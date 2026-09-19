import { z } from "zod";

/** Direction of a transfer ticket. A ticket authorizes one path, one way. */
export const WorkspaceTransferDirectionSchema = z.enum(["download", "upload"]);

export type WorkspaceTransferDirection = z.infer<
  typeof WorkspaceTransferDirectionSchema
>;

/** Identity of a file at the moment a transfer was authorized.
 *
 * The inode and modification time together detect a destination that was
 * replaced while a transfer was in flight, so a slower upload never overwrites
 * a newer file.
 */
export const WorkspaceFileIdentitySchema = z.object({
  size: z.number().int().nonnegative(),
  mtimeNs: z.string(),
  ino: z.string(),
});

export type WorkspaceFileIdentity = z.infer<typeof WorkspaceFileIdentitySchema>;

export const WorkspaceFileStatSchema = z.union([
  z.object({ path: z.string(), present: z.literal(false) }),
  WorkspaceFileIdentitySchema.extend({
    path: z.string(),
    present: z.literal(true),
  }),
]);

export type WorkspaceFileStat = z.infer<typeof WorkspaceFileStatSchema>;

/** A pinned copy of a file, safe to read across resumed ranges. */
export const WorkspaceSnapshotSchema = WorkspaceFileIdentitySchema.extend({
  transferId: z.string(),
  path: z.string(),
  sha256: z.string(),
});

export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/** A workspace-relative path. The in-Pod helper is the authority on traversal
 * and symlinks; this only rejects the obviously malformed before a round trip. */
const TransferPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes("\0"), "Path must not contain NUL");

export const StartWorkspaceTransferSchema = z.discriminatedUnion("direction", [
  z.object({
    direction: z.literal("download"),
    path: TransferPathSchema,
  }),
  z.object({
    direction: z.literal("upload"),
    path: TransferPathSchema,
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "Expected a hex sha256 digest"),
  }),
]);

export const StartedWorkspaceTransferSchema = z.object({
  transferId: z.string(),
  /** Returned once. Only a hash of it is retained. */
  token: z.string(),
  contentUrl: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  expiresInSeconds: z.number().int().positive(),
});

export const WorkspaceUploadReceiptSchema = z.object({
  uploadId: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

export type WorkspaceUploadReceipt = z.infer<
  typeof WorkspaceUploadReceiptSchema
>;

export const WorkspaceFinalizeResultSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

export type WorkspaceFinalizeResult = z.infer<
  typeof WorkspaceFinalizeResultSchema
>;
