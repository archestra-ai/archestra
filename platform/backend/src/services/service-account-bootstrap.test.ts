// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { enterpriseTier } from "@/enterprise-tier";
import ServiceAccountModel from "@/models/service-account";
import ServiceAccountFederatedCredentialModel from "@/models/service-account-federated-credential";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { bootstrapServiceAccounts } from "./service-account-bootstrap";

const ACCOUNT_ID = "6f1d7d2e-4a52-4c3e-9c1f-0d5b8a7e2b10";
const CREDENTIAL = {
  name: "crossplane provider",
  issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE",
  audience: "https://archestra.example.com",
  subject: "system:serviceaccount:crossplane-system:provider-archestra",
};
const DECLARED = [
  {
    id: ACCOUNT_ID,
    name: "crossplane",
    description: "Crossplane provider",
    role: "member",
    federatedCredentials: [CREDENTIAL],
  },
];

describe("bootstrapServiceAccounts", () => {
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    enterpriseTier.setUserCountForTesting(0);
  });

  afterEach(() => {
    enterpriseTier.setUserCountForTesting(0);
  });

  test("creates the declared account with its fixed ID and federated credential", async () => {
    await bootstrapServiceAccounts(DECLARED);

    const account = await ServiceAccountModel.findById(
      ACCOUNT_ID,
      organizationId,
    );
    expect(account).toMatchObject({
      name: "crossplane",
      description: "Crossplane provider",
      role: "member",
    });
    expect(
      await ServiceAccountFederatedCredentialModel.listForServiceAccount({
        serviceAccountId: ACCOUNT_ID,
        organizationId,
      }),
    ).toMatchObject([{ ...CREDENTIAL, claimConditions: {} }]);
  });

  test("is idempotent and keeps edits made after the first run", async () => {
    await bootstrapServiceAccounts(DECLARED);
    await ServiceAccountModel.update(ACCOUNT_ID, organizationId, {
      role: "admin",
    });

    await bootstrapServiceAccounts(DECLARED);

    expect(
      (await ServiceAccountModel.findById(ACCOUNT_ID, organizationId))?.role,
    ).toBe("admin");
    expect(
      await ServiceAccountFederatedCredentialModel.countForServiceAccount(
        ACCOUNT_ID,
      ),
    ).toBe(1);
  });

  test("adds a missing credential to an account that already exists by name", async () => {
    const existing = await ServiceAccountModel.create({
      organizationId,
      name: "crossplane",
      role: "member",
      createdBy: null,
    });

    await bootstrapServiceAccounts([
      {
        name: "crossplane",
        role: "member",
        federatedCredentials: [CREDENTIAL],
      },
    ]);

    expect(
      await ServiceAccountFederatedCredentialModel.countForServiceAccount(
        existing.id,
      ),
    ).toBe(1);
  });

  test("skips an account it cannot create and still creates the others", async () => {
    await ServiceAccountModel.create({
      organizationId,
      name: "taken",
      role: "member",
      createdBy: null,
    });

    await bootstrapServiceAccounts([
      { name: "unknown role", role: "no-such-role" },
      { id: ACCOUNT_ID, name: "taken", role: "member" },
      {
        name: "private issuer",
        role: "member",
        federatedCredentials: [{ ...CREDENTIAL, issuer: "https://10.0.0.1" }],
      },
      { name: "valid", role: "member" },
    ]);

    expect(
      await ServiceAccountModel.findIdByName(organizationId, "unknown role"),
    ).toBeNull();
    expect(
      await ServiceAccountModel.findById(ACCOUNT_ID, organizationId),
    ).toBeNull();
    expect(
      await ServiceAccountModel.findIdByName(organizationId, "private issuer"),
    ).toBeNull();
    expect(
      await ServiceAccountModel.findIdByName(organizationId, "valid"),
    ).not.toBeNull();
  });

  test("creates nothing without an Enterprise license", async () => {
    enterpriseTier.setUserCountForTesting(9999);

    await bootstrapServiceAccounts(DECLARED);

    expect(
      await ServiceAccountModel.findById(ACCOUNT_ID, organizationId),
    ).toBeNull();
  });

  test("fails on an invalid declaration", async () => {
    await expect(
      bootstrapServiceAccounts([{ name: "no role" }]),
    ).rejects.toThrow(
      /ARCHESTRA_AUTH_SERVICE_ACCOUNT_BOOTSTRAP is invalid: 0\.role/,
    );
    await expect(
      bootstrapServiceAccounts([
        {
          name: "x",
          role: "member",
          federatedCredentials: [{ ...CREDENTIAL, issuer: "http://insecure" }],
        },
      ]),
    ).rejects.toThrow(/federatedCredentials/);
  });
});
