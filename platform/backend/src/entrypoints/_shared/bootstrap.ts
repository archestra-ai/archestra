import { initializeDatabase } from "@/database";

/**
 * Initialize essential services for entrypoint scripts.
 * Lighter than the full Fastify server — only sets up the database.
 */
export async function bootstrap(): Promise<void> {
  await initializeDatabase();
}

/**
 * Parse a named CLI argument from process.argv.
 * Supports both `--name=value` and `--name value` forms.
 */
export function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
    if (arg === `--${name}` && i + 1 < process.argv.length) {
      return process.argv[i + 1];
    }
  }
  return undefined;
}
