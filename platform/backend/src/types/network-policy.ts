import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// === Public schemas & types ===

export const NetworkPolicyEgressModeSchema = z.enum([
  "off",
  "restricted",
  "unrestricted",
]);

export const NetworkPolicyDomainPresetSchema = z.enum([
  "none",
  "common_dependencies",
  "package_managers",
]);

export const NetworkPolicyAllowedHttpMethodsSchema = z.enum([
  "all",
  "read_only",
]);

const NetworkPolicyDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i,
    "Must be a domain such as api.example.com or *.example.com",
  )
  .transform((domain) => domain.toLowerCase());

export const SelectNetworkPolicySchema = createSelectSchema(
  schema.networkPoliciesTable,
).extend({
  egressMode: NetworkPolicyEgressModeSchema,
  domainPreset: NetworkPolicyDomainPresetSchema,
  allowedDomains: z.array(z.string()),
  allowedHttpMethods: NetworkPolicyAllowedHttpMethodsSchema,
});

export const CreateNetworkPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    egressMode: NetworkPolicyEgressModeSchema.optional(),
    domainPreset: NetworkPolicyDomainPresetSchema.optional(),
    allowedDomains: z.array(NetworkPolicyDomainSchema).optional(),
    allowedHttpMethods: NetworkPolicyAllowedHttpMethodsSchema.optional(),
  })
  .superRefine(validateNetworkPolicyInput);

export const UpdateNetworkPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    egressMode: NetworkPolicyEgressModeSchema.optional(),
    domainPreset: NetworkPolicyDomainPresetSchema.optional(),
    allowedDomains: z.array(NetworkPolicyDomainSchema).optional(),
    allowedHttpMethods: NetworkPolicyAllowedHttpMethodsSchema.optional(),
  })
  .superRefine(validateNetworkPolicyInput);

export const NetworkPolicyReferenceCountsSchema = z.object({
  environments: z.number().int().nonnegative(),
  defaultEnvironments: z.number().int().nonnegative(),
  catalogItems: z.number().int().nonnegative(),
  mcpServerInstallations: z.number().int().nonnegative(),
});

export const NetworkPolicyWithReferencesSchema =
  SelectNetworkPolicySchema.extend({
    references: NetworkPolicyReferenceCountsSchema,
  });

export const EffectiveNetworkPolicySchema = z.object({
  source: z.enum([
    "installation",
    "catalog",
    "environment",
    "organization_default",
    "built_in",
  ]),
  policy: SelectNetworkPolicySchema.nullable(),
});

export type NetworkPolicyEgressMode = z.infer<
  typeof NetworkPolicyEgressModeSchema
>;
export type NetworkPolicyDomainPreset = z.infer<
  typeof NetworkPolicyDomainPresetSchema
>;
export type NetworkPolicyAllowedHttpMethods = z.infer<
  typeof NetworkPolicyAllowedHttpMethodsSchema
>;
export type NetworkPolicy = z.infer<typeof SelectNetworkPolicySchema>;
export type CreateNetworkPolicy = z.infer<typeof CreateNetworkPolicySchema>;
export type UpdateNetworkPolicy = z.infer<typeof UpdateNetworkPolicySchema>;
export type NetworkPolicyReferenceCounts = z.infer<
  typeof NetworkPolicyReferenceCountsSchema
>;
export type NetworkPolicyWithReferences = z.infer<
  typeof NetworkPolicyWithReferencesSchema
>;
export type EffectiveNetworkPolicy = z.infer<
  typeof EffectiveNetworkPolicySchema
>;

// === Internal helpers ===

function validateNetworkPolicyInput(
  value: {
    allowedDomains?: string[];
  },
  ctx: z.RefinementCtx,
) {
  const domains = value.allowedDomains ?? [];
  if (new Set(domains).size !== domains.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowedDomains"],
      message: "Allowed domains must be unique.",
    });
  }
}
