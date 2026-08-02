import { describe, expect, it } from "vitest";
import {
  isManagedSecretEnvVar,
  stripAllPlaintextSecretFields,
  stripManagedPlaintextSecretFields,
} from "./catalog-plaintext-secrets";

const contaminatedLocalConfig = () => ({
  command: "run",
  environment: [
    {
      key: "TOKEN",
      type: "secret",
      promptOnInstallation: false,
      value: "leaked-token",
    },
    {
      key: "PROMPTED",
      type: "secret",
      promptOnInstallation: true,
      value: "template-value",
    },
    {
      key: "MODE",
      type: "plain_text",
      promptOnInstallation: false,
      value: "prod",
    },
  ],
  imagePullSecrets: [
    {
      source: "credentials",
      server: "registry.example.com",
      username: "bot",
      password: "leaked-password",
    },
    { source: "existing", name: "pull-secret" },
  ],
});

describe("isManagedSecretEnvVar", () => {
  it("matches secret vars that are not prompt-on-install", () => {
    expect(
      isManagedSecretEnvVar({ type: "secret", promptOnInstallation: false }),
    ).toBe(true);
    expect(isManagedSecretEnvVar({ type: "secret" })).toBe(true);
    expect(
      isManagedSecretEnvVar({ type: "secret", promptOnInstallation: true }),
    ).toBe(false);
    expect(
      isManagedSecretEnvVar({
        type: "plain_text",
        promptOnInstallation: false,
      }),
    ).toBe(false);
  });
});

describe("stripAllPlaintextSecretFields", () => {
  it("strips every plaintext secret surface, including prompt-on-install template values", () => {
    const stripped = stripAllPlaintextSecretFields({
      localConfig: contaminatedLocalConfig(),
      oauthConfig: { client_id: "id", client_secret: "leaked-client-secret" },
      enterpriseManagedConfig: { clientSecretOverride: "leaked-override" },
    });

    const localConfig = stripped.localConfig as ReturnType<
      typeof contaminatedLocalConfig
    >;
    expect(localConfig.environment[0]).not.toHaveProperty("value");
    expect(localConfig.environment[1]).not.toHaveProperty("value");
    // Plain-text values are config, not secrets.
    expect(localConfig.environment[2].value).toBe("prod");
    expect(localConfig.imagePullSecrets[0]).not.toHaveProperty("password");
    expect(localConfig.imagePullSecrets[1]).toEqual({
      source: "existing",
      name: "pull-secret",
    });
    expect(stripped.oauthConfig).toEqual({ client_id: "id" });
    expect(stripped.enterpriseManagedConfig).toEqual({});
  });

  it("strips non-canonical legacy shapes it cannot schema-parse", () => {
    // promptOnInstallation missing entirely — the select schema would reject
    // this entry, which is exactly why the strip is structural.
    const stripped = stripAllPlaintextSecretFields({
      localConfig: {
        environment: [{ key: "TOKEN", type: "secret", value: "leaked-token" }],
      },
    });
    expect(
      (stripped.localConfig as { environment: object[] }).environment[0],
    ).toEqual({ key: "TOKEN", type: "secret" });
  });

  it("passes through null, undefined, and odd non-object shapes untouched", () => {
    expect(
      stripAllPlaintextSecretFields({
        localConfig: null,
        oauthConfig: undefined,
        enterpriseManagedConfig: "not-an-object",
      }),
    ).toEqual({
      localConfig: null,
      oauthConfig: undefined,
      enterpriseManagedConfig: "not-an-object",
    });
    expect(
      stripAllPlaintextSecretFields({
        localConfig: { environment: "not-an-array" },
      }),
    ).toEqual({ localConfig: { environment: "not-an-array" } });
  });

  it("never mutates its input", () => {
    const input = {
      localConfig: contaminatedLocalConfig(),
      oauthConfig: { client_id: "id", client_secret: "leaked-client-secret" },
      enterpriseManagedConfig: { clientSecretOverride: "leaked-override" },
    };
    stripAllPlaintextSecretFields(input);
    expect(input.localConfig.environment[0].value).toBe("leaked-token");
    expect(input.localConfig.imagePullSecrets[0].password).toBe(
      "leaked-password",
    );
    expect(input.oauthConfig.client_secret).toBe("leaked-client-secret");
    expect(input.enterpriseManagedConfig.clientSecretOverride).toBe(
      "leaked-override",
    );
  });
});

describe("stripManagedPlaintextSecretFields", () => {
  it("strips managed values only where the matching secret bundle is in play", () => {
    const { values, strippedPaths } = stripManagedPlaintextSecretFields({
      values: {
        localConfig: contaminatedLocalConfig(),
        oauthConfig: { client_id: "id", client_secret: "leaked-client-secret" },
        enterpriseManagedConfig: { clientSecretOverride: "leaked-override" },
      },
      hasClientSecretBundle: true,
      hasLocalConfigSecretBundle: true,
    });

    const localConfig = values.localConfig as ReturnType<
      typeof contaminatedLocalConfig
    >;
    expect(localConfig.environment[0]).not.toHaveProperty("value");
    // Prompt-on-install values are per-install user input, not catalog
    // secrets — the PUT route leaves them, so the write boundary must too.
    expect(localConfig.environment[1].value).toBe("template-value");
    expect(localConfig.environment[2].value).toBe("prod");
    expect(localConfig.imagePullSecrets[0]).not.toHaveProperty("password");
    expect(values.oauthConfig).toEqual({ client_id: "id" });
    expect(values.enterpriseManagedConfig).toEqual({});
    expect(strippedPaths.sort()).toEqual([
      "enterpriseManagedConfig.clientSecretOverride",
      "localConfig.environment[TOKEN].value",
      "localConfig.imagePullSecrets[registry.example.com].password",
      "oauthConfig.client_secret",
    ]);
  });

  it("preserves inline values on bundle-less surfaces (legacy rows)", () => {
    const { values, strippedPaths } = stripManagedPlaintextSecretFields({
      values: {
        localConfig: contaminatedLocalConfig(),
        oauthConfig: { client_id: "id", client_secret: "legacy-inline-secret" },
      },
      hasClientSecretBundle: false,
      hasLocalConfigSecretBundle: false,
    });
    expect(values).toEqual({
      localConfig: contaminatedLocalConfig(),
      oauthConfig: { client_id: "id", client_secret: "legacy-inline-secret" },
    });
    expect(strippedPaths).toEqual([]);
  });

  it("mirrors the route's truthiness rule: empty-string values are left alone", () => {
    const { values, strippedPaths } = stripManagedPlaintextSecretFields({
      values: {
        localConfig: {
          environment: [
            {
              key: "TOKEN",
              type: "secret",
              promptOnInstallation: false,
              value: "",
            },
          ],
        },
        oauthConfig: { client_id: "id", client_secret: "" },
      },
      hasClientSecretBundle: true,
      hasLocalConfigSecretBundle: true,
    });
    expect(
      (values.localConfig as { environment: { value?: string }[] })
        .environment[0].value,
    ).toBe("");
    expect(values.oauthConfig).toEqual({ client_id: "id", client_secret: "" });
    expect(strippedPaths).toEqual([]);
  });

  it("never mutates its input", () => {
    const values = {
      localConfig: contaminatedLocalConfig(),
      oauthConfig: { client_id: "id", client_secret: "leaked-client-secret" },
    };
    stripManagedPlaintextSecretFields({
      values,
      hasClientSecretBundle: true,
      hasLocalConfigSecretBundle: true,
    });
    expect(values.localConfig.environment[0].value).toBe("leaked-token");
    expect(values.oauthConfig.client_secret).toBe("leaked-client-secret");
  });
});
