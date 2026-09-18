import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
  openappaBatteryInstallsTable,
  openappaBatteryPackagesTable,
  openappaEffectivePoliciesTable,
} from "@/database/schemas/openappa-batteries";

export const BatteryPackageFileSchema = z.strictObject({
  path: z.string().min(1).max(512),
  text: z.string().max(1_048_576),
});
export type BatteryPackageFile = z.infer<typeof BatteryPackageFileSchema>;

/** Battery credential name (an `APPA_PROVIDER_*` variable) → runtime credential definition key. */
export const BatteryCredentialBindingsSchema = z.record(
  z.string().regex(/^APPA_PROVIDER_[A-Z0-9_]+$/),
  z.string().min(1).max(200),
);
export type BatteryCredentialBindings = z.infer<
  typeof BatteryCredentialBindingsSchema
>;

export const BatteryInstallSchema = createSelectSchema(
  openappaBatteryInstallsTable,
).extend({
  credentialBindings: BatteryCredentialBindingsSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BatteryInstall = z.infer<typeof BatteryInstallSchema>;

export const BatteryPackageSchema = createSelectSchema(
  openappaBatteryPackagesTable,
).extend({
  files: z.array(BatteryPackageFileSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BatteryPackage = z.infer<typeof BatteryPackageSchema>;

export const EffectivePolicySchema = createSelectSchema(
  openappaEffectivePoliciesTable,
).extend({
  compiledAt: z.coerce.date(),
  lastErrorAt: z.coerce.date().nullable(),
});
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export const BatterySourceSchema = z.enum(["bundled", "organization"]);
export type BatterySource = z.infer<typeof BatterySourceSchema>;

export const BatterySummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  source: BatterySourceSchema,
  namespaces: z.array(z.string()),
  helpers: z.array(z.string()),
  credentials: z.array(z.string()),
  setup: z.string().nullable(),
  installs: z.array(BatteryInstallSchema),
});
export type BatterySummary = z.infer<typeof BatterySummarySchema>;

export const CreateBatteryInstallSchema = z.strictObject({
  batteryName: z.string().min(1).max(100),
  catalogId: z.string().uuid(),
  enabled: z.boolean().default(true),
  credentialBindings: BatteryCredentialBindingsSchema.default({}),
});
export type CreateBatteryInstall = z.infer<typeof CreateBatteryInstallSchema>;

export const UpdateBatteryInstallSchema = z.strictObject({
  enabled: z.boolean().optional(),
  credentialBindings: BatteryCredentialBindingsSchema.optional(),
});
export type UpdateBatteryInstall = z.infer<typeof UpdateBatteryInstallSchema>;

export const UploadBatteryPackageSchema = z.strictObject({
  files: z.array(BatteryPackageFileSchema).min(1).max(64),
});
export type UploadBatteryPackage = z.infer<typeof UploadBatteryPackageSchema>;
