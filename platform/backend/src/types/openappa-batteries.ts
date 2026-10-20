import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
  openappaBatteryInstallsTable,
  openappaBatteryPackagesTable,
  openappaCredentialBindingsTable,
  openappaEffectivePoliciesTable,
} from "@/database/schemas/openappa-batteries";

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

/** One organization-wide binding of a helper variable to a runtime credential key. */
export const CredentialBindingSchema = createSelectSchema(
  openappaCredentialBindingsTable,
).extend({
  variable: z.string().regex(BATTERY_CREDENTIAL_VARIABLE),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;

/**
 * Where a variable's key comes from: a `[credentials]` line in the policy text,
 * which wins, or a stored binding filling a variable the text leaves out.
 */
export const CredentialSourceSchema = z.enum(["policy", "binding"]);
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

export const CredentialBindingParamsSchema = z.object({
  variable: z.string().regex(BATTERY_CREDENTIAL_VARIABLE),
});

/** The key to bind a variable to; null unbinds it. */
export const SetCredentialBindingSchema = z.strictObject({
  key: z.string().min(1).max(200).nullable(),
});

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

/** The target a battery deploys as here; a hosted deployment never takes single-user. */
export const BatteryTargetNameSchema = z.enum(["multi-user"]);
export type BatteryTargetName = z.infer<typeof BatteryTargetNameSchema>;

/**
 * What a battery governs: the servers its namespaces' aliases point at, or the
 * whole organization for a battery made of annotators alone, which a policy rule
 * routes a tool to by name.
 */
export const BatteryScopeSchema = z.enum(["catalogs", "organization"]);
export type BatteryScope = z.infer<typeof BatteryScopeSchema>;

export const BatteryInstallSchema = createSelectSchema(
  openappaBatteryInstallsTable,
).extend({
  status: BatteryInstallStatusSchema,
  target: z.union([BatteryTargetNameSchema, z.null()]),
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
  /** Null when the battery deploys as its base alone. */
  target: z.union([BatteryTargetNameSchema, z.null()]),
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

/**
 * One battery of a served composition as it was composed: its status, and
 * the install whose id its helper URLs carry, with the package, target and
 * credential keys that install deployed.
 */
const ServedBatterySchema = z.object({
  /** The include entry; null when it was derived from install rows. */
  entry: z.string().nullable(),
  name: z.string(),
  status: BatteryInstallStatusSchema,
  composed: z.boolean(),
  packageHash: z.string().nullable(),
  target: z.union([BatteryTargetNameSchema, z.null()]),
  installId: z.string().nullable(),
  credentialBindings: z.record(z.string(), z.string()),
});

/**
 * Where an effective policy's `content` came from, stored beside it. It is a
 * composition (of a known revision, or of an unknown one for a row an earlier
 * build stored), or the root text alone when no composition ever opened.
 * `contentHash` anchors it to the bytes it describes.
 */
export const ServedCompositionSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1),
    kind: z.literal("composition"),
    contentHash: z.string(),
    rootRevision: z.number().int().nullable(),
    composedAt: z.string().nullable(),
    batteries: z.array(ServedBatterySchema).nullable(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("root_only"),
    contentHash: z.string(),
    rootRevision: z.number().int(),
  }),
]);
export type ServedComposition = z.infer<typeof ServedCompositionSchema>;

/**
 * What an effective policy keeps for conversations that started under earlier
 * policies, stored beside it: each kept annotator with the opening policies
 * that need it and when a conversation under them was last active, the names
 * no active conversation needs any more, and when to check again.
 * `contentHash` anchors it to the bytes it describes.
 */
export const RetainedAnnotatorsSchema = z.object({
  v: z.literal(1),
  contentHash: z.string(),
  horizonDays: z.number().int(),
  checkedAt: z.string(),
  /** When the next kept annotator may lose its last active conversation; null when nothing needs a check. */
  recheckAt: z.string().nullable(),
  /** False when conversation activity could not be read, so every candidate was kept. */
  livenessKnown: z.boolean(),
  kept: z.array(
    z.object({
      name: z.string(),
      binding: z.string(),
      openingHashes: z.array(z.string()),
      liveRoots: z.number().int(),
      lastActivityAt: z.string().nullable(),
    }),
  ),
  inactive: z.array(
    z.object({
      name: z.string(),
      binding: z.string(),
      openingHashes: z.array(z.string()),
    }),
  ),
  dropped: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type RetainedAnnotators = z.infer<typeof RetainedAnnotatorsSchema>;

export const EffectivePolicySchema = createSelectSchema(
  openappaEffectivePoliciesTable,
).extend({
  compiledAt: z.coerce.date(),
  lastErrorAt: z.coerce.date().nullable(),
  served: ServedCompositionSchema.nullable(),
  retainedAnnotators: RetainedAnnotatorsSchema.nullable(),
});

/** The annotators kept for earlier conversations, as the API shows them. */
const RetainedAnnotatorsViewSchema = z.object({
  /** 0: kept for as long as a policy that needs them is stored. */
  horizonDays: z.number().int(),
  livenessKnown: z.boolean(),
  kept: z.array(
    z.object({
      name: z.string(),
      binding: z.string(),
      /** Conversations under the policies that need it, active within the horizon. */
      liveRoots: z.number().int(),
      lastActivityAt: z.coerce.date().nullable(),
      /** When it stops being kept unless one of them is active again; null with horizon 0. */
      retiresAt: z.coerce.date().nullable(),
    }),
  ),
  /** No longer kept: no conversation that needs it was active within the horizon. */
  inactive: z.array(z.object({ name: z.string(), binding: z.string() })),
  dropped: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

/** A battery of the composition the runtime enforces, as a reader sees it. */
const ServedBatteryViewSchema = ServedBatterySchema.pick({
  name: true,
  status: true,
  composed: true,
});

/**
 * What the runtime enforces and what was refused, as two facts. `current`:
 * the latest revision composed. `previous`: the latest attempt was refused
 * and an earlier composition stays enforced (its revision, time and battery
 * statuses are null when an earlier build stored it). `root_only`: nothing
 * ever composed, so governed calls are refused.
 */
export const CompositionViewSchema = z.object({
  served: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("current"),
      rootRevision: z.number().int(),
      composedAt: z.coerce.date(),
    }),
    z.object({
      kind: z.literal("previous"),
      rootRevision: z.number().int().nullable(),
      composedAt: z.coerce.date().nullable(),
      batteries: z.array(ServedBatteryViewSchema).nullable(),
    }),
    z.object({ kind: z.literal("root_only") }),
  ]),
  refusal: z
    .object({
      message: z.string(),
      at: z.coerce.date(),
      /** Null when the row was marked stale before the attempt was stored. */
      rootRevision: z.number().int().nullable(),
    })
    .nullable(),
});
export type CompositionView = z.infer<typeof CompositionViewSchema>;

/** The effective policy as the API returns it: the stored row with its composition view. */
export const EffectivePolicyViewSchema = EffectivePolicySchema.omit({
  served: true,
  retainedAnnotators: true,
}).extend({
  composition: CompositionViewSchema,
  retained: RetainedAnnotatorsViewSchema.nullable(),
  /**
   * The deployment head and its publication time. A saved change publishes at
   * the next protected live call; null before the first publish. Pinned
   * families keep their opening policy.
   */
  servedRevision: z
    .object({ revision: z.number().int(), publishedAt: z.date() })
    .nullable(),
});
export type EffectivePolicyView = z.infer<typeof EffectivePolicyViewSchema>;

/** Where an include entry's bytes come from: the pinned bundle or a stored upload. */
export const BatterySourceSchema = z.enum(["bundled", "upload"]);
export type BatterySource = z.infer<typeof BatterySourceSchema>;

/** The policy file supplied by an exact include in the organization's root TOML. */
export const BatteryPolicySourceSchema = z.object({
  entry: z.string(),
  name: z.string(),
  content: z.string(),
});

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
  scope: BatteryScopeSchema,
  helpers: z.array(z.string()),
  credentials: z.array(z.string()),
  setup: z.string().nullable(),
  installs: z.array(BatteryInstallSchema),
});
export type BatterySummary = z.infer<typeof BatterySummarySchema>;

/** One `aliases.mcp` target beside the catalog it resolves to, if any does. */
const BatteryServerViewSchema = z.object({
  target: z.string(),
  catalogId: z.string().nullable(),
});

/** One credential variable a battery reads, with its key and every other reader. */
const BatteryCredentialViewSchema = z.object({
  variable: z.string(),
  key: z.string().nullable(),
  /** Null while the variable is unbound; a union so the generated client keeps the null. */
  source: z.union([CredentialSourceSchema, z.null()]),
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

/** An alias whose namespace no included battery declares: inert, not refused. */
const UnusedAliasViewSchema = z.object({
  namespace: z.string(),
  servers: z.array(z.string()),
  line: z.number(),
});

export const PolicyDeclarationsViewSchema = z.object({
  batteries: z.array(
    PolicyBatteryViewSchema.extend({
      /**
       * How the composition the runtime enforces holds this battery; null
       * when it does not hold it (declared since, or nothing is enforced).
       * Under a current composition it equals the battery's own status.
       */
      served: ServedBatteryViewSchema.pick({
        status: true,
        composed: true,
      }).nullable(),
    }),
  ),
  unusedAliases: z.array(UnusedAliasViewSchema),
  rootRevision: z.number(),
  /** The refusal message; read `composition.refusal` for what it refused. */
  lastError: z.string().nullable(),
  composition: CompositionViewSchema,
  managedInGithub: z.boolean(),
  /**
   * The stored bindings, including those of variables no included battery
   * reads yet; a battery's own `credentials` say which key it composes with.
   */
  credentialBindings: z.array(
    z.object({ variable: z.string(), key: z.string() }),
  ),
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
