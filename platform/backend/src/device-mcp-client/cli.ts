import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DeviceMcpCompanion } from "./client";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    code: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !values.url || !values.code) {
  console.error(
    "Usage: node device-mcp-client.mjs --url https://deployment.example --code PAIRING_CODE\nSource: pnpm --dir backend exec tsx src/device-mcp-client/cli.ts --url https://deployment.example --code PAIRING_CODE",
  );
  process.exitCode = values.help ? 0 : 1;
} else {
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"] as const) {
    process.once(event, () => controller.abort());
  }
  try {
    const companion = new DeviceMcpCompanion(
      values.url,
      undefined,
      console.error,
    );
    await companion.pair(
      values.code,
      async ({ config, configDigest, launch }) => {
        console.error(`Connect to: ${new URL(values.url ?? "").origin}`);
        console.error(
          `Reviewed configuration: ${config.version}\nSHA-256: ${configDigest}`,
        );
        console.error(
          `Executable and arguments: ${JSON.stringify([launch.command, ...launch.args])}`,
        );
        console.error(
          `Tools: ${config.tools.map((tool) => tool.name).join(", ")}`,
        );
        console.error(
          "This grants your account access to these tools on this computer while this process runs. No credential is saved. Stop with Ctrl+C, or revoke the device in the registry.",
        );
        if (!process.stdin.isTTY)
          throw new Error(
            "Pairing requires an interactive terminal for device consent.",
          );
        const terminal = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          return (
            (await terminal.question(
              "Type CONNECT to pair this device and launch the reviewed MCP: ",
              { signal: controller.signal },
            )) === "CONNECT"
          );
        } finally {
          terminal.close();
        }
      },
      controller.signal,
    );
    await companion.run(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(
        error instanceof Error ? error.message : "Device connection failed",
      );
      process.exitCode = 1;
    }
  }
}
