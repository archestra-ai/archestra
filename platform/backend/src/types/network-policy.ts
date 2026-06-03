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

const NetworkPolicyCidrSchema = z
  .string()
  .trim()
  .refine(
    isValidCidr,
    "Must be a CIDR such as 203.0.113.0/24 or 2001:db8::/32",
  );

export const SelectNetworkPolicySchema = createSelectSchema(
  schema.networkPoliciesTable,
).extend({
  egressMode: NetworkPolicyEgressModeSchema,
  domainPreset: NetworkPolicyDomainPresetSchema,
  allowedDomains: z.array(z.string()),
  allowedCidrs: z.array(z.string()),
});

export const CreateNetworkPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    egressMode: NetworkPolicyEgressModeSchema.optional(),
    domainPreset: NetworkPolicyDomainPresetSchema.optional(),
    allowedDomains: z.array(NetworkPolicyDomainSchema).max(500).optional(),
    allowedCidrs: z.array(NetworkPolicyCidrSchema).max(500).optional(),
  })
  .superRefine(validateNetworkPolicyInput);

export const UpdateNetworkPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    egressMode: NetworkPolicyEgressModeSchema.optional(),
    domainPreset: NetworkPolicyDomainPresetSchema.optional(),
    allowedDomains: z.array(NetworkPolicyDomainSchema).max(500).optional(),
    allowedCidrs: z.array(NetworkPolicyCidrSchema).max(500).optional(),
  })
  .superRefine(validateNetworkPolicyInput);

export const NetworkPolicyReferenceCountsSchema = z.object({
  environments: z.number().int().nonnegative(),
  defaultEnvironments: z.number().int().nonnegative(),
});

export const NetworkPolicyWithReferencesSchema =
  SelectNetworkPolicySchema.extend({
    references: NetworkPolicyReferenceCountsSchema,
  });

export const EffectiveNetworkPolicySchema = z.object({
  source: z.enum(["environment", "organization_default", "built_in"]),
  policy: SelectNetworkPolicySchema.nullable(),
});

export const K8sNetworkPolicyCapabilitiesSchema = z.object({
  kubernetesNetworkPolicy: z.boolean(),
  ciliumNetworkPolicy: z.boolean(),
  gkeFqdnNetworkPolicy: z.boolean(),
  awsApplicationNetworkPolicy: z.boolean(),
  provider: z.enum([
    "cilium",
    "gke-fqdn",
    "aws-application-network-policy",
    "kubernetes",
    "none",
  ]),
  supportsFqdn: z.boolean(),
  supportsHttpMethods: z.boolean(),
  message: z.string().nullable(),
});

export const K8sCapabilitiesSchema = z.object({
  networkPolicy: K8sNetworkPolicyCapabilitiesSchema,
});

export type NetworkPolicyEgressMode = z.infer<
  typeof NetworkPolicyEgressModeSchema
>;
export type NetworkPolicyDomainPreset = z.infer<
  typeof NetworkPolicyDomainPresetSchema
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
export type K8sNetworkPolicyCapabilities = z.infer<
  typeof K8sNetworkPolicyCapabilitiesSchema
>;
export type K8sCapabilities = z.infer<typeof K8sCapabilitiesSchema>;

// === Internal helpers ===

function validateNetworkPolicyInput(
  value: {
    allowedDomains?: string[];
    allowedCidrs?: string[];
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

  const cidrs = value.allowedCidrs ?? [];
  if (new Set(cidrs).size !== cidrs.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowedCidrs"],
      message: "Allowed CIDRs must be unique.",
    });
  }
}

function isValidCidr(value: string): boolean {
  const [address, prefixRaw] = value.split("/");
  if (!address || !prefixRaw || !/^\d+$/.test(prefixRaw)) {
    return false;
  }

  const prefix = Number(prefixRaw);
  if (address.includes(":")) {
    return prefix >= 0 && prefix <= 128 && isValidIpv6(address);
  }

  return prefix >= 0 && prefix <= 32 && isValidIpv4(address);
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const number = Number(part);
      return number >= 0 && number <= 255 && String(number) === part;
    })
  );
}

function isValidIpv6(value: string): boolean {
  if (value === "::") {
    return true;
  }

  if (!/^[0-9a-f:]+$/i.test(value) || value.includes(":::")) {
    return false;
  }

  const doubleColonCount = value.split("::").length - 1;
  if (doubleColonCount > 1) {
    return false;
  }

  const groups = value
    .split("::")
    .flatMap((part) => (part.length === 0 ? [] : part.split(":")));
  return (
    groups.length <= (doubleColonCount === 1 ? 7 : 8) &&
    groups.length >= (doubleColonCount === 1 ? 1 : 8) &&
    groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
  );
}
