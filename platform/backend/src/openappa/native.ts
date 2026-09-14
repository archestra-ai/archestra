import config from "@/config";
import { getDatabaseConnectionString } from "@/database";

let native: Promise<typeof import("@archestra/openappa-rs")> | undefined;

export async function openappaNative() {
  if (!config.openappa.enabled || !config.openappa.policyPath) {
    throw new Error("OpenAPPA is disabled or its policy path is missing");
  }
  const policyPath = config.openappa.policyPath;
  native ??= (async () => {
    const module = await import("@archestra/openappa-rs");
    const url = new URL(getDatabaseConnectionString());
    // pg ignores Prisma's legacy schema parameter; rust-postgres rejects it.
    url.searchParams.delete("schema");
    await module.initializeOpenappa(
      url.toString(),
      policyPath,
      config.openappa.approvalSigningSecret,
    );
    return module;
  })().catch((error) => {
    native = undefined;
    throw error;
  });
  return native;
}
