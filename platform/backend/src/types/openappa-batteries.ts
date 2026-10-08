import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
  openappaBatteryInstallsTable,
  openappaBatteryPackagesTable,
  openappaEffectivePoliciesTable,
} from "@/database/schemas/openappa-batteries";
import { HeldPullReasonSchema } from "@/types/openappa-github-sync";

export const BatteryPackageFileSchema = z.strictObject({
  path: z.string().min(1).max(512),
  text: z.string().max(1_048_576),
});
export type BatteryPackageFile = z.infer<typeof BatteryPackageFileSchema>;

/** The variables a battery may read: the runtime's provider-credential namespace. */
export const BATTERY_CREDENTIAL_VARIABLE = /^APPA_PROVIDER_[A-Z0-9_]+$/;

/** Battery credential name (an `APPA_PROVIDER_*` variable) → runtime credential definition key. */
export const BatteryCredentialBindingsSchema = z.record(
  z.string().regex(BATTERY_CREDENTIAL_VARIABLE),
  z.string().min(1).max(200),
);
export type BatteryCredentialBindings = z.infer<
  typeof BatteryCredentialBindingsSchema
>;

/** Why a declared battery does or does not take part in the composed policy, by precedence. */
export const BatteryInstallStatusSchema = z.enum([
  "unavailable",
  "missing_credentials",
  "naming_conflict",
  "server_missing",
  "unrouted",
  "refused",
  "active",
]);
export type BatteryInstallStatus = z.infer<typeof BatteryInstallStatusSchema>;

/**
 * What a battery governs: the servers its namespaces' aliases point at, or the
 * whole organization for a battery made of annotators alone, which a policy rule
 * routes a tool to by name.
 */
export const BatteryScopeSchema = z.enum(["catalogs", "organization"]);
export type BatteryScope = z.infer<typeof BatteryScopeSchema>;

/**
 * What a battery is attached to: a registry catalog, a detected MCP server (a
 * client's own, named by its `<family>.<label>` id), or the whole organization
 * for a battery made of annotators alone.
 */
export const BatteryAttachmentKindSchema = z.enum([
  "catalog",
  "detected",
  "organization",
]);
export type BatteryAttachmentKind = z.infer<typeof BatteryAttachmentKindSchema>;

/** An attachment to one server: the kinds an alias target can resolve to. */
export const BatteryServerAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), catalogId: z.string().uuid() }),
  z.object({ kind: z.literal("detected"), detectedId: z.string().min(1) }),
]);
export type BatteryServerAttachment = z.infer<
  typeof BatteryServerAttachmentSchema
>;

export const BatteryAttachmentSchema = z.discriminatedUnion("kind", [
  ...BatteryServerAttachmentSchema.options,
  z.object({ kind: z.literal("organization") }),
]);
export type BatteryAttachment = z.infer<typeof BatteryAttachmentSchema>;

export const BatteryInstallSchema = createSelectSchema(
  openappaBatteryInstallsTable,
).extend({
  kind: BatteryAttachmentKindSchema.nullable(),
  status: BatteryInstallStatusSchema,
  credentialBindings: BatteryCredentialBindingsSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BatteryInstall = z.infer<typeof BatteryInstallSchema>;

/**
 * The attachment a stored row stands for. A row written before `kind` existed
 * has none stored; its catalog column says which it was.
 */
export function attachmentOf(
  row: Pick<BatteryInstall, "kind" | "catalogId" | "detectedId">,
): BatteryAttachment {
  switch (row.kind) {
    case "catalog":
      return { kind: "catalog", catalogId: row.catalogId as string };
    case "detected":
      return { kind: "detected", detectedId: row.detectedId as string };
    case "organization":
      return { kind: "organization" };
    case null:
      return row.catalogId === null
        ? { kind: "organization" }
        : { kind: "catalog", catalogId: row.catalogId };
  }
}

export function sameAttachment(
  a: BatteryAttachment,
  b: BatteryAttachment,
): boolean {
  return attachmentKey(a) === attachmentKey(b);
}

/** One string per attachment, for map keys and row identity. */
export function attachmentKey(attachment: BatteryAttachment): string {
  switch (attachment.kind) {
    case "catalog":
      return `catalog:${attachment.catalogId}`;
    case "detected":
      return `detected:${attachment.detectedId}`;
    case "organization":
      return "organization";
  }
}

/** The identity a recompose and the store agree on: one row per (battery, attachment). */
export function installIdentityKey(
  batteryName: string,
  attachment: BatteryAttachment,
): string {
  return `${batteryName}\u0000${attachmentKey(attachment)}`;
}

/** One derived install as a recompose computes it; ids are the model's to preserve. */
export const BatteryInstallRowSchema = z.strictObject({
  batteryName: z.string().min(1).max(100),
  attachment: BatteryAttachmentSchema,
  status: BatteryInstallStatusSchema,
  packageHash: z.string().nullable(),
  lastError: z.string().nullable(),
  credentialBindings: BatteryCredentialBindingsSchema,
});
export type BatteryInstallRow = z.infer<typeof BatteryInstallRowSchema>;

export const BatteryPackageSchema = createSelectSchema(
  openappaBatteryPackagesTable,
).extend({
  files: z.array(BatteryPackageFileSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BatteryPackage = z.infer<typeof BatteryPackageSchema>;
/** A stored package's identity: enough to find its inspected form or fetch its files. */
export type BatteryPackageSummary = Pick<
  BatteryPackage,
  "organizationId" | "name" | "contentHash" | "description" | "createdAt"
>;

export const EffectivePolicySchema = createSelectSchema(
  openappaEffectivePoliciesTable,
).extend({
  compiledAt: z.coerce.date(),
  lastErrorAt: z.coerce.date().nullable(),
});
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

/** Where an include entry's bytes come from: the pinned bundle or a stored upload. */
export const BatterySourceSchema = z.enum(["bundled", "upload"]);
export type BatterySource = z.infer<typeof BatterySourceSchema>;

/** The policy file supplied by an exact include in the organization's root TOML. */
export const BatteryPolicySourceSchema = z.object({
  entry: z.string(),
  name: z.string(),
  content: z.string(),
});

/**
 * What a server was matched on: a catalog entry's host or image, its name
 * alone (weak), or, for a detected server, the tools its battery's rules name.
 */
export const BatteryMatchEvidenceSchema = z.enum([
  "host",
  "image",
  "name",
  "tool",
]);
export type BatteryMatchEvidence = z.infer<typeof BatteryMatchEvidenceSchema>;

/** A battery a catalog entry stands for, with the install it already has. */
export const BatteryMatchSchema = z.object({
  battery: z.string(),
  evidence: BatteryMatchEvidenceSchema,
  install: BatteryInstallSchema.nullable(),
});
export type BatteryMatch = z.infer<typeof BatteryMatchSchema>;

/**
 * Whether an attach to a catalog has an alias target: `unsynced` while none of
 * its tools are synced, `conflicting` when a tool prefix holds `__`, which a
 * composed alias cannot tell apart. An attach is refused in both.
 */
export const AttachReadinessSchema = z.enum([
  "ready",
  "unsynced",
  "conflicting",
]);
export type AttachReadiness = z.infer<typeof AttachReadinessSchema>;

/** The server whose batteries are asked for: a catalog entry or a detected server, one of the two. */
export const BatteryMatchesQuerySchema = z
  .object({
    catalogId: z.uuid().optional(),
    detectedId: z.string().min(1).optional(),
  })
  .refine(
    (query) =>
      (query.catalogId === undefined) !== (query.detectedId === undefined),
    "Name exactly one of catalogId and detectedId",
  );

/** The batteries a server stands for, and whether one can be attached. */
export const BatteryMatchesSchema = z.object({
  attach: AttachReadinessSchema,
  matches: z.array(BatteryMatchSchema),
});
export type BatteryMatches = z.infer<typeof BatteryMatchesSchema>;

export const BatterySummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  source: BatterySourceSchema,
  /** The bytes the newest stored package of this name holds; null when bundled. */
  contentHash: z.string().nullable(),
  namespaces: z.array(z.string()),
  /** The annotators it declares; with no namespace, it governs the organization, not a catalog. */
  annotators: z.array(z.string()),
  scope: BatteryScopeSchema,
  helpers: z.array(z.string()),
  credentials: z.array(z.string()),
  setup: z.string().nullable(),
  installs: z.array(BatteryInstallSchema),
});
export type BatterySummary = z.infer<typeof BatterySummarySchema>;

/**
 * One `[server_aliases]` target beside the server it resolves to, if one does.
 * `catalogId` repeats a catalog attachment's id for a client that reads the
 * older shape.
 */
const BatteryServerViewSchema = z.object({
  target: z.string(),
  attachment: BatteryServerAttachmentSchema.nullable(),
  catalogId: z.string().nullable(),
});

/** One credential variable a battery reads, with its key and every other reader. */
const BatteryCredentialViewSchema = z.object({
  variable: z.string(),
  key: z.string().nullable(),
  readers: z.array(z.string()),
});

/** One include entry as the panel shows it: what it spells and what came of it. */
export const PolicyBatteryViewSchema = z.object({
  entry: z.string(),
  name: z.string(),
  source: BatterySourceSchema,
  packageHash: z.string().nullable(),
  status: BatteryInstallStatusSchema,
  /** `catalogs` too for an entry that resolves to nothing. */
  scope: BatteryScopeSchema,
  /** Whether it composes its own policy; otherwise it folds in as the empty stub. */
  composed: z.boolean(),
  line: z.number(),
  servers: z.array(BatteryServerViewSchema),
  credentials: z.array(BatteryCredentialViewSchema),
  helpers: z.array(z.string()),
});
export type PolicyBatteryView = z.infer<typeof PolicyBatteryViewSchema>;

/** An alias whose namespace no included battery declares; a hand-written rule may still bind through it. */
const AliasWithoutIncludedBatteryViewSchema = z.object({
  namespace: z.string(),
  servers: z.array(z.string()),
  line: z.number(),
});

/** A pulled document the sync fetched and did not publish. */
const HeldPullViewSchema = z.object({
  contentHash: z.string(),
  sourceCommit: z.string(),
  reasons: z.array(HeldPullReasonSchema),
});

export const PolicyDeclarationsViewSchema = z.object({
  batteries: z.array(PolicyBatteryViewSchema),
  aliasesWithoutIncludedBattery: z.array(AliasWithoutIncludedBatteryViewSchema),
  /** The same list under its former name, for a client from before the rename. */
  unusedAliases: z.array(AliasWithoutIncludedBatteryViewSchema),
  rootRevision: z.number(),
  lastError: z.string().nullable(),
  managedInGithub: z.boolean(),
  heldPull: HeldPullViewSchema.nullable(),
});
export type PolicyDeclarationsView = z.infer<
  typeof PolicyDeclarationsViewSchema
>;

/** What an upload answers: the stored bytes and the entry that spells them. */
export const UploadedBatteryPackageSchema = z.object({
  name: z.string(),
  description: z.string(),
  contentHash: z.string(),
  entry: z.string(),
  namespaces: z.array(z.string()),
  /** The annotators it declares; with no namespace, it governs the organization, not a catalog. */
  annotators: z.array(z.string()),
  helpers: z.array(z.string()),
  credentials: z.array(z.string()),
  setup: z.string().nullable(),
});
export type UploadedBatteryPackage = z.infer<
  typeof UploadedBatteryPackageSchema
>;

export const CreateBatteryInstallSchema = z.strictObject({
  batteryName: z.string().min(1).max(100),
  /** The server to govern; absent for a battery made of annotators alone. */
  attachment: BatteryServerAttachmentSchema.optional(),
  /** The stored package to include; absent spells the bundled battery. */
  packageHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
});
export type CreateBatteryInstall = z.infer<typeof CreateBatteryInstallSchema>;

export const UpdateBatteryInstallSchema = z.strictObject({
  enabled: z.boolean().optional(),
  credentialBindings: BatteryCredentialBindingsSchema.optional(),
});
export type UpdateBatteryInstall = z.infer<typeof UpdateBatteryInstallSchema>;

export const UploadBatteryPackageSchema = z.strictObject({
  files: z
    .array(BatteryPackageFileSchema)
    .min(1)
    .max(64)
    .refine(
      (files) => new Set(files.map((file) => file.path)).size === files.length,
      "Each file path may appear once",
    ),
});
export type UploadBatteryPackage = z.infer<typeof UploadBatteryPackageSchema>;
