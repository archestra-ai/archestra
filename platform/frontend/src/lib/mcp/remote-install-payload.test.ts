import { describe, expect, it } from "vitest";
import { buildRemoteInstallCredentialPayload } from "./remote-install-payload";

describe("buildRemoteInstallCredentialPayload", () => {
  it("forwards client-credentials metadata as userConfigValues for standard installs", () => {
    expect(
      buildRemoteInstallCredentialPayload({
        metadata: {
          client_id: "client-id",
          client_secret: "client-secret",
          audience: "https://api.example.com",
        },
        isByosVault: false,
      }),
    ).toEqual({
      userConfigValues: {
        client_id: "client-id",
        client_secret: "client-secret",
        audience: "https://api.example.com",
      },
      isByosVault: false,
    });
  });

  it("uses accessToken when metadata contains an access token", () => {
    expect(
      buildRemoteInstallCredentialPayload({
        metadata: {
          access_token: "pat-token",
          client_id: "ignored-client-id",
        },
        isByosVault: false,
      }),
    ).toEqual({
      accessToken: "pat-token",
      isByosVault: false,
    });
  });

  it("preserves BYOS metadata and stringifies scalar values", () => {
    expect(
      buildRemoteInstallCredentialPayload({
        metadata: {
          client_secret: "vault/path#secret",
          retries: 3,
          enabled: true,
        },
        isByosVault: true,
      }),
    ).toEqual({
      userConfigValues: {
        client_secret: "vault/path#secret",
        retries: "3",
        enabled: "true",
      },
      isByosVault: true,
    });
  });
});
