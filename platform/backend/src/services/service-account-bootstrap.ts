// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import {
  OrganizationModel,
  OrganizationRoleModel,
  ServiceAccountModel,
} from "@/models";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import { assertPublicIssuer } from "@/services/workload-identity/federated-token";
import {
  type ServiceAccountBootstrap,
  ServiceAccountBootstrapSchema,
} from "@/types/service-account-bootstrap";

// ===================================================================
// Public API
// ===================================================================

/**
 * Create the service accounts and federated credentials declared in
 * `ARCHESTRA_AUTH_SERVICE_ACCOUNT_BOOTSTRAP`, so a workload can sign in with
 * its own OIDC token from the first deploy, with no API key to hand out.
 *
 * Runs after migrations and seeding, on every start. Only what is missing is
 * created, matched by name: an account or credential that already exists is
 * left as it is, so later edits in the UI, API or Terraform stick. Replicas
 * starting together are safe: the names are unique, and losing the race to
 * create one counts as already existing.
 *
 * An invalid declaration fails startup. An account that cannot be created
 * (unknown role, private issuer, name held by another ID) is logged and
 * skipped, so one mistake does not keep Archestra down.
 */
export async function bootstrapServiceAccounts(
  declared: unknown[] | null = config.auth.serviceAccountBootstrap,
): Promise<void> {
  if (!declared) return;
  const parsed = ServiceAccountBootstrapSchema.safeParse(declared);
  if (!parsed.success) {
    throw new Error(
      `ARCHESTRA_AUTH_SERVICE_ACCOUNT_BOOTSTRAP is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  if (!enterpriseTier.isCoreActive()) {
    logger.warn(
      "[service-account-bootstrap] Skipped: federated credentials require an Enterprise license",
    );
    return;
  }
  const organization = await OrganizationModel.getFirst();
  if (!organization) return;

  for (const account of parsed.data) {
    try {
      await ensureServiceAccount({ organizationId: organization.id, account });
    } catch (error) {
      logger.error(
        {
          serviceAccount: account.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "[service-account-bootstrap] Could not bootstrap service account",
      );
    }
  }
}

// ===================================================================
// Internal helpers
// ===================================================================

async function ensureServiceAccount(params: {
  organizationId: string;
  account: ServiceAccountBootstrap[number];
}): Promise<void> {
  const { organizationId, account } = params;
  for (const credential of account.federatedCredentials)
    assertPublicIssuer(credential.issuer);
  const serviceAccountId = await findOrCreateServiceAccount({
    organizationId,
    account,
  });
  for (const credential of account.federatedCredentials) {
    if (
      await ServiceAccountFederatedCredentialModel.isNameTaken({
        serviceAccountId,
        name: credential.name,
      })
    )
      continue;
    if (
      (await ServiceAccountFederatedCredentialModel.countForServiceAccount(
        serviceAccountId,
      )) >= ServiceAccountFederatedCredentialModel.MAX_PER_SERVICE_ACCOUNT
    )
      throw new Error(
        `A service account can have at most ${ServiceAccountFederatedCredentialModel.MAX_PER_SERVICE_ACCOUNT} federated credentials`,
      );
    try {
      await ServiceAccountFederatedCredentialModel.create({
        organizationId,
        serviceAccountId,
        name: credential.name,
        issuer: credential.issuer,
        audience: credential.audience,
        subject: credential.subject,
        claimConditions: credential.claimConditions ?? {},
        createdBy: null,
      });
      logger.info(
        { serviceAccount: account.name, credential: credential.name },
        "[service-account-bootstrap] Created federated credential",
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

async function findOrCreateServiceAccount(params: {
  organizationId: string;
  account: ServiceAccountBootstrap[number];
}): Promise<string> {
  const { organizationId, account } = params;
  if (
    account.id &&
    (await ServiceAccountModel.findById(account.id, organizationId))
  )
    return account.id;

  const existingId = await ServiceAccountModel.findIdByName(
    organizationId,
    account.name,
  );
  if (existingId) {
    if (account.id && existingId !== account.id)
      throw new Error(
        `The name "${account.name}" belongs to service account ${existingId}, not the declared ID ${account.id}`,
      );
    return existingId;
  }

  await assertRolesExist({ organizationId, roles: account.roles });
  try {
    const created = await ServiceAccountModel.create({
      id: account.id,
      organizationId,
      name: account.name,
      description: account.description,
      // The account column holds several roles comma-separated.
      role: [...new Set(account.roles)].join(","),
      createdBy: null,
    });
    logger.info(
      { serviceAccount: account.name, id: created.id },
      "[service-account-bootstrap] Created service account",
    );
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another replica created it first.
    const racedId = await ServiceAccountModel.findIdByName(
      organizationId,
      account.name,
    );
    if (!racedId) throw error;
    return racedId;
  }
}

async function assertRolesExist(params: {
  organizationId: string;
  roles: string[];
}): Promise<void> {
  for (const role of new Set(params.roles)) {
    if (
      !(await OrganizationRoleModel.getByIdentifier(
        role,
        params.organizationId,
      ))
    )
      throw new Error(`Role "${role}" does not exist`);
  }
}

/** Postgres unique_violation, as surfaced by pg and PGlite drivers. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause;
  return code === "23505" || cause?.code === "23505";
}
