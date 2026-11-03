import { DeviceMcpCompanion } from "./client";

// Exactly one approved installation per child. Credentials arrive over IPC,
// never argv, environment variables, logs, or a plaintext persistence file.
const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM", "disconnect"] as const) {
  process.once(event, () => controller.abort());
}
process.once("message", async (message: unknown) => {
  try {
    if (!message || typeof message !== "object")
      throw new Error("Missing session");
    const session = message as Parameters<DeviceMcpCompanion["restore"]>[0] & {
      url: string;
    };
    const companion = new DeviceMcpCompanion(
      session.url,
      undefined,
      (message) =>
        process.send?.({
          state: message.includes("is ready") ? "ready" : "connecting",
        }),
    );
    companion.restore(session);
    await companion.run(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number(error.status)
          : 0;
      process.send?.({
        state: "failed",
        status,
        reason:
          error instanceof Error && error.message.includes("do not match")
            ? "MCP tools changed; review this installation again"
            : "Could not start this MCP; check its approved executable and local prerequisites",
      });
      process.exitCode = 1;
    }
  } finally {
    if (process.connected) process.disconnect();
  }
});
