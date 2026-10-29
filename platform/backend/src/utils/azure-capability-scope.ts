import { createHash } from "node:crypto";

/** Bind evidence to routing/credential configuration without storing header values. */
export function azureCapabilityConfigurationHash(params: {
  baseUrl: string | null | undefined;
  inferenceBaseUrl: string | null | undefined;
  extraHeaders: Record<string, string> | null | undefined;
  secretId: string | null | undefined;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseUrl: params.baseUrl ?? null,
        inferenceBaseUrl: params.inferenceBaseUrl ?? null,
        secretId: params.secretId ?? null,
        headers: Object.entries(params.extraHeaders ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      }),
    )
    .digest("hex");
}
