// Spike-only types. Mirrors the proposed catalog/environment/install model
// without touching the real schema. Everything here is mock data.

export type FieldKind = "env" | "user";
export type FieldType = "string" | "number" | "secret" | "bool";
export type UserFieldSource = "prompt-install" | "header-per-call";

export type FieldDef = {
  key: string;
  kind: FieldKind;
  type: FieldType;
  required: boolean;
  description?: string;
  // For user fields only:
  source?: UserFieldSource;
  // For env fields only: when set, the field is fixed at the catalog level
  // and not prompted per-environment.
  staticValue?: string;
};

export type MappingTarget =
  | { kind: "env-var"; name: string }
  | { kind: "header"; name: string }
  | { kind: "secret-file"; path: string };

export type Mapping =
  | { source: { kind: "field"; key: string }; target: MappingTarget }
  | {
      source: { kind: "template"; template: string };
      target: MappingTarget;
    };

export type Tenancy = "single" | "multi";
export type Transport = "streamable-http" | "stdio";

export type CatalogItem = {
  id: string;
  name: string;
  tenancy: Tenancy;
  transport: Transport;
  command?: string;
  args: string[];
  image?: string;
  httpPort?: number;
  httpPath?: string;
  fields: FieldDef[];
  mappings: Mapping[];
  authType: "none" | "token" | "oauth" | "jwt" | "idp-exchange";
  labels: string[];
};

export type EnvironmentVisibility =
  | { kind: "org" }
  | { kind: "team"; teamId: string; teamName: string };

export type Environment = {
  id: string;
  catalogId: string;
  label: string;
  visibility: EnvironmentVisibility;
  fieldValues: Record<string, string | number | boolean>;
  isDefault: boolean;
  createdAt: string;
};

export type Scope = "personal" | "team" | "org";

export type Credential = {
  id: string;
  environmentId: string;
  ownerId: string;
  ownerEmail: string;
  scope: Scope;
  // For multitenant catalogs every credential maps to the catalog-shared pod;
  // for single-tenant each credential maps to its own pod.
  podId: string;
  secretStorage: "Database" | "Vault";
  createdAt: string;
};

export type PodStatus = "up" | "down" | "restarting" | "degraded";

export type Pod = {
  id: string;
  name: string;
  catalogId: string;
  // null for multitenant pods that span environments? No — even multitenant
  // pods belong to one catalog, but in our model the multitenant pod still
  // maps 1:1 to one environment because env field values bake into headers
  // assembled per call. For single-tenant the pod is per (env, scope-target).
  environmentId: string;
  ownerLabel: string; // "shared" for multitenant, owner email for personal, team name for team
  tenancy: Tenancy;
  status: PodStatus;
  startedAt: string;
  restarts: number;
  image: string;
  callerCount: number;
};

export type Team = { id: string; name: string };
