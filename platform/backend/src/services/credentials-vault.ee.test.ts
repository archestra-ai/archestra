// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { SecretsManagerType } from "@archestra/shared";
import { vi } from "vitest";
import { secretManager, secretManagerCoordinator } from "@/secrets-manager";
import {
  createRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import {
  CredentialResolutionBatch,
  preflightMcpCredentials,
  resolveCredentialValue,
  resolveMcpCredentialValues,
} from "@/services/credentials";
import { expect, test } from "@/test";
import type { ISecretManager } from "@/types";

test("one unreadable Vault credential must not block an independently healthy credential", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const owner = { organizationId: org.id, userId: user.id };
  for (const key of ["healthy", "unreadable"]) {
    await createRuntimeCredentialDefinition({
      ...owner,
      definition: {
        key,
        name: key,
        description: "",
        icon: null,
        allowPersonal: true,
        allowOrganization: false,
      },
    });
    await setRuntimeCredentialConnection({
      ...owner,
      scope: "personal",
      credentialId: key,
      value: key,
    });
  }
  const storage = secretManager();
  const vault: ISecretManager = Object.create(storage);
  Object.defineProperty(vault, "type", { value: SecretsManagerType.Vault });
  const denied = new Error("Vault access denied for this synthetic credential");
  const getSecret = vi.fn<ISecretManager["getSecret"]>(async (id, options) => {
    const result = await storage.getSecret(id, options);
    if (result?.secret.value === "unreadable") throw denied;
    return result;
  });
  vault.getSecret = getSecret;
  const provider = vi
    .spyOn(secretManagerCoordinator, "getCurrentInstance")
    .mockReturnValue(vault);
  try {
    expect(
      await resolveCredentialValue({
        ...owner,
        scope: "personal",
        credentialId: "healthy",
      }),
    ).toBe("healthy");
    const batch = await CredentialResolutionBatch.create({
      ...owner,
      credentialIds: ["healthy", "unreadable"],
    });
    getSecret.mockClear();
    await expect(
      batch.resolve({
        ...owner,
        scope: "personal",
        credentialId: "unreadable",
      }),
    ).rejects.toBe(denied);
    await expect(
      batch.resolve({ ...owner, scope: "personal", credentialId: "healthy" }),
    ).resolves.toEqual({ value: "healthy", expiresAt: null });
    expect(getSecret).toHaveBeenCalledTimes(2);
    expect(
      getSecret.mock.calls.every(([, options]) => options?.skipCache === true),
    ).toBe(true);
    const params = {
      ...owner,
      installationScope: "personal",
      environment: ["healthy", "unreadable"].map((key) => ({
        key,
        type: "secret",
        credentialId: key,
        credentialScope: "personal" as const,
        promptOnInstallation: false,
        required: true,
      })),
    };
    const blockers = await preflightMcpCredentials(params);
    await expect(resolveMcpCredentialValues(params)).rejects.toBe(denied);
    expect(blockers.map((blocker) => blocker.credentialId)).toEqual([
      "unreadable",
    ]);
  } finally {
    provider.mockRestore();
  }
});
