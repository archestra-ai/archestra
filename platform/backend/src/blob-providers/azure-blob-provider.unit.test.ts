import { describe, expect, test } from "vitest";
import { AzureBlobProvider } from "./azure-blob-provider";

describe("AzureBlobProvider", () => {
  test("object locations never carry the SAS token", () => {
    const provider = new AzureBlobProvider({
      config: {
        type: "azure_blob",
        accountName: "finopsexports",
        container: "cost-exports",
        keyPrefix: "archestra",
        endpoint: null,
        authMethod: "sas_token",
        tenantId: null,
        clientId: null,
      },
      credentials: { sasToken: "sv=2026-04-06&sp=cwd&sig=secret" },
    });

    const location = (
      provider as unknown as { locationOf: (key: string) => string }
    ).locationOf("archestra/file.csv");

    expect(location).toBe(
      "https://finopsexports.blob.core.windows.net/cost-exports/archestra/file.csv",
    );
  });

  test("an Entra sign-in error keeps only the AADSTS reason", () => {
    const provider = new AzureBlobProvider({
      config: {
        type: "azure_blob",
        accountName: "finopsexports",
        container: "cost-exports",
        keyPrefix: "",
        endpoint: null,
        authMethod: "service_principal",
        tenantId: "tenant",
        clientId: "client",
      },
      credentials: { clientSecret: "x" },
    });
    const error = Object.assign(
      new Error(
        "unauthorized_client: Error(s): 700016 - Timestamp: 2026-11-11 - Description: AADSTS700016: Application with identifier 'client' was not found in the directory. Trace ID: abc Correlation ID: def",
      ),
      { name: "AuthenticationRequiredError" },
    );

    expect(provider.describeError(error)).toBe(
      "Microsoft Entra sign-in failed: AADSTS700016: Application with identifier 'client' was not found in the directory.",
    );
  });
});
