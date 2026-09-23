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
  "refused",
  "active",
]);
export type BatteryInstallStatus = z.infer<typeof BatteryInstallStatusSchema>;

export const BatteryInstallSchema = createSelectSchema(
  openappaBatteryInstallsTable,
).extend({
  status: BatteryInstallStatusSchema,
  credentialBindings: BatteryCredentialBindingsSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BatteryInstall = z.infer<typeof BatteryInstallSchema>;

/**
 * One derived install as a recompose computes it; ids are the model's to preserve.
 * A battery made of annotators alone governs no catalog: its one row has none.
 */
export const BatteryInstallRowSchema = z.strictObject({
  batteryName: z.string().min(1).max(100),
  catalogId: z.string().uuid().nullable(),
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

/** What a catalog entry was matched on; a name alone is a weak signal. */
export const BatteryMatchEvidenceSchema = z.enum(["host", "image", "name"]);
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

/** The batteries a catalog entry stands for, and whether one can be attached. */
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
  helpers: z.array(z.string()),
  credentials: z.array(z.string()),
  setup: z.string().nullable(),
  installs: z.array(BatteryInstallSchema),
});
export type BatterySummary = z.infer<typeof BatterySummarySchema>;

/** One `[server_aliases]` target beside the catalog it resolves to, if any does. */
const BatteryServerViewSchema = z.object({
  target: z.string(),
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
  line: z.number(),
  servers: z.array(BatteryServerViewSchema),
  credentials: z.array(BatteryCredentialViewSchema),
  helpers: z.array(z.string()),
});
export type PolicyBatteryView = z.infer<typeof PolicyBatteryViewSchema>;

/** An alias whose namespace no included battery declares: inert, not refused. */
const UnusedAliasViewSchema = z.object({
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
  unusedAliases: z.array(UnusedAliasViewSchema),
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
  /** The catalog to govern; absent for a battery made of annotators alone. */
  catalogId: z.string().uuid().optional(),
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
