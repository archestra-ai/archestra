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

export const NetworkPolicySchema = z.object({
  egressMode: NetworkPolicyEgressModeSchema,
  domainPreset: NetworkPolicyDomainPresetSchema,
  allowedDomains: z.array(z.string()),
  allowedCidrs: z.array(z.string()),
});

export const NetworkPolicyInputSchema = z
  .object({
    egressMode: NetworkPolicyEgressModeSchema.optional(),
    domainPreset: NetworkPolicyDomainPresetSchema.optional(),
    allowedDomains: z
      .array(createNetworkPolicyDomainSchema())
      .max(500)
      .optional(),
    allowedCidrs: z.array(createNetworkPolicyCidrSchema()).max(500).optional(),
  })
  .superRefine(validateNetworkPolicyInput)
  .transform((policy) => normalizeNetworkPolicy(policy));

export const EffectiveNetworkPolicySchema = z.object({
  source: z.enum(["environment", "organization_default", "built_in"]),
  policy: NetworkPolicySchema.nullable(),
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

export const SelectEnvironmentSchema = createSelectSchema(
  schema.environmentsTable,
).extend({
  networkPolicy: NetworkPolicySchema.nullable(),
});

/**
 * Listing response shape — row columns plus the number of catalog items
 * currently assigned to this environment, for delete-confirmation UI.
 */
export const EnvironmentWithAssignedCountSchema =
  SelectEnvironmentSchema.extend({
    assignedCatalogCount: z.number().int().nonnegative(),
  });

/**
 * Full listing payload: the org's environments plus the count of catalog items
 * with no environment (which implicitly belong to the default environment).
 */
export const EnvironmentListSchema = z.object({
  environments: z.array(EnvironmentWithAssignedCountSchema),
  defaultAssignedCatalogCount: z.number().int().nonnegative(),
});

const KubernetesNamespaceSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "Must be a valid Kubernetes namespace name (lowercase letters, numbers, and hyphens only)",
  );

export const CreateEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(500).nullable().optional(),
  namespace: KubernetesNamespaceSchema.nullable().optional(),
  networkPolicy: NetworkPolicyInputSchema.nullable().optional(),
  restricted: z.boolean().optional(),
});

/**
 * All editable fields. Send `null` to clear the nullable ones (namespace,
 * description).
 */
export const UpdateEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  namespace: KubernetesNamespaceSchema.nullable().optional(),
  networkPolicy: NetworkPolicyInputSchema.nullable().optional(),
  restricted: z.boolean().optional(),
});

export type Environment = z.infer<typeof SelectEnvironmentSchema>;
export type EnvironmentWithAssignedCount = z.infer<
  typeof EnvironmentWithAssignedCountSchema
>;
export type EnvironmentList = z.infer<typeof EnvironmentListSchema>;
export type CreateEnvironment = z.infer<typeof CreateEnvironmentSchema>;
export type UpdateEnvironment = z.infer<typeof UpdateEnvironmentSchema>;
export type NetworkPolicyEgressMode = z.infer<
  typeof NetworkPolicyEgressModeSchema
>;
export type NetworkPolicyDomainPreset = z.infer<
  typeof NetworkPolicyDomainPresetSchema
>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type NetworkPolicyInput = z.input<typeof NetworkPolicyInputSchema>;
export type EffectiveNetworkPolicy = z.infer<
  typeof EffectiveNetworkPolicySchema
>;
export type K8sNetworkPolicyCapabilities = z.infer<
  typeof K8sNetworkPolicyCapabilitiesSchema
>;
export type K8sCapabilities = z.infer<typeof K8sCapabilitiesSchema>;

// === Internal helpers ===

function createNetworkPolicyDomainSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(
      /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i,
      "Must be a domain such as api.example.com or *.example.com",
    )
    .transform((domain) => domain.toLowerCase());
}

function createNetworkPolicyCidrSchema() {
  return z
    .string()
    .trim()
    .refine(
      isValidCidr,
      "Must be a CIDR such as 203.0.113.0/24 or 2001:db8::/32",
    );
}

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

function normalizeNetworkPolicy(value: {
  egressMode?: NetworkPolicyEgressMode;
  domainPreset?: NetworkPolicyDomainPreset;
  allowedDomains?: string[];
  allowedCidrs?: string[];
}): NetworkPolicy {
  const egressMode = value.egressMode ?? "restricted";
  return {
    egressMode,
    domainPreset:
      egressMode === "restricted" ? (value.domainPreset ?? "none") : "none",
    allowedDomains:
      egressMode === "restricted" ? (value.allowedDomains ?? []) : [],
    allowedCidrs: egressMode === "restricted" ? (value.allowedCidrs ?? []) : [],
  };
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
