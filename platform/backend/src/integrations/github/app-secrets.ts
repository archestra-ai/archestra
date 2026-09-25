import { z } from "zod";
import { ApiError } from "@/types/api";

/** Legacy installation-only connections contain a PEM; OAuth-enabled Apps also hold a client secret. */
export function parseGitHubAppSecrets(value: string) {
  if (value.trimStart().startsWith("-----BEGIN"))
    return { privateKey: value, clientSecret: undefined };
  try {
    return z
      .object({
        privateKey: z.string().min(1),
        clientSecret: z.string().min(1),
      })
      .parse(JSON.parse(value));
  } catch {
    throw new ApiError(
      400,
      "Reconnect the GitHub App private key and OAuth client secret",
    );
  }
}
