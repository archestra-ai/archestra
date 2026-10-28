// @vitest-environment node
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
      }),
    ).toEqual({
      userConfigValues: {
        client_id: "client-id",
        client_secret: "client-secret",
        audience: "https://api.example.com",
      },
    });
  });

  it("uses accessToken when metadata contains an access token", () => {
    expect(
      buildRemoteInstallCredentialPayload({
        metadata: {
          access_token: "pat-token",
          client_id: "ignored-client-id",
        },
      }),
    ).toEqual({
      accessToken: "pat-token",
    });
  });
});
