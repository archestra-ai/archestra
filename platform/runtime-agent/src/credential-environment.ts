import { readFile } from "node:fs/promises";
import { z } from "zod";

/** Reread the atomic Secret-volume projection before every managed command. */
export async function credentialEnvironment(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  const file = env.ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE;
  if (!file) return env;
  try {
    const bundle = BundleSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (bundle.taskId !== env.ARCHESTRA_AGENT_RUNTIME_TASK_ID)
      throw new Error("Credential owner changed");
    for (const [key, credential] of Object.entries(bundle.credentials)) {
      if (!credential.value || credential.expiresAt <= Date.now())
        throw new Error("Credential expired");
      env[key] = credential.value;
    }
    if (bundle.credentials.GITHUB_TOKEN && !bundle.credentials.GH_TOKEN)
      env.GH_TOKEN = env.GITHUB_TOKEN;
    return env;
  } catch {
    // Never include parsed file contents, token values, or parser diagnostics.
    throw new Error(
      "Renewable credentials are unavailable or expired. Retry after credential refresh.",
    );
  }
}

const BundleSchema = z.object({
  taskId: z.string(),
  credentials: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.object({
      value: z.string(),
      expiresAt: z.number().finite(),
    }),
  ),
});
