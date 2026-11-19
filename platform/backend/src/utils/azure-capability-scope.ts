import { createHmac } from "node:crypto";
import config from "@/config";

/**
 * Bind persisted capability evidence to its routing/credential configuration.
 * Headers may contain low-entropy credentials: a bare hash would expose an
 * offline guessing oracle if the evidence leaked. This MAC is an identity
 * check, not a password verifier. The shared deployment secret keeps it stable
 * across replicas/restarts; rotation makes existing evidence stale until sync.
 */
export function azureCapabilityConfigurationHash(params: {
  baseUrl: string | null | undefined;
  inferenceBaseUrl: string | null | undefined;
  extraHeaders: Record<string, string> | null | undefined;
  secretId: string | null | undefined;
}): string {
  const secret = config.auth.secret;
  if (!secret) {
    throw new Error(
      "An auth secret is required to fingerprint Azure capability configuration",
    );
  }
  const digest = createHmac("sha256", secret)
    .update("archestra:azure-capability-configuration:v1\0")
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
  // A format prefix also prevents accepting legacy, unkeyed SHA-256 evidence.
  return `hmac-sha256-v1:${digest}`;
}
