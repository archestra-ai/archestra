import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { parseDeviceConnectionFile } from "./connection-file";

const InspectionSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string(),
  organizationName: z.string(),
  ownerName: z.string(),
  capabilities: z.array(z.literal("local_mcp")),
});
const EnrollmentSchema = z.object({
  deviceId: z.string().uuid(),
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  name: z.string(),
});
export const LocalDeviceCredentialSchema = EnrollmentSchema.extend({
  version: z.literal(1),
  url: z.string().url(),
}).strict();
export type LocalDeviceCredential = z.infer<typeof LocalDeviceCredentialSchema>;
export type LocalDeviceInspection = z.infer<typeof InspectionSchema>;

export class LocalDeviceAccessError extends Error {
  constructor(readonly status: number) {
    super(
      status === 409
        ? "This device connected in another session. Choose Reconnect to use this app."
        : "This device connection is no longer authorized. Add this computer again in Personal Settings → Devices.",
    );
  }
  get credentialInvalid() {
    return this.status !== 409;
  }
}

/** Presence-only enrollment: this client has no tool execution or filesystem API. */
export class LocalDeviceClient {
  private sessionId: string | undefined;
  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    // Reuse the setup-file origin validation, without accepting extra paths or credentials.
    parseDeviceConnectionFile(
      JSON.stringify({
        version: 2,
        purpose: "local-device",
        url,
        code: "a".repeat(43),
      }),
    );
  }
  async enroll(
    code: string,
    metadata: {
      platform: "darwin" | "win32" | "linux";
      arch: "arm64" | "x64";
      appVersion: string;
    },
    approve: (details: LocalDeviceInspection) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<LocalDeviceCredential> {
    const inspected = InspectionSchema.parse(
      await this.request("inspect", { code }, undefined, signal),
    );
    if (!(await approve(inspected)))
      throw new Error("Device connection cancelled.");
    signal?.throwIfAborted();
    const enrolled = EnrollmentSchema.parse(
      await this.request("redeem", { code, ...metadata }, undefined, signal),
    );
    if (enrolled.deviceId !== inspected.deviceId)
      throw new Error(
        "The device changed during approval. Add this computer again.",
      );
    return { ...enrolled, version: 1, url: new URL(this.url).origin };
  }
  async run(
    credential: LocalDeviceCredential,
    report: (state: "online" | "connecting", name: string) => void,
    signal: AbortSignal,
    intervalMs = 15_000,
  ) {
    let failureDelay = 1000;
    let name = credential.name;
    try {
      while (!signal.aborted) {
        try {
          if (Date.parse(credential.expiresAt) <= Date.now())
            throw new LocalDeviceAccessError(401);
          this.sessionId = z
            .object({ sessionId: z.string().uuid() })
            .parse(
              await this.request("session", {}, credential.token, signal),
            ).sessionId;
          failureDelay = 1000;
          while (!signal.aborted) {
            const heartbeat = z
              .object({ success: z.literal(true), name: z.string() })
              .parse(
                await this.request(
                  "heartbeat",
                  { sessionId: this.sessionId },
                  credential.token,
                  signal,
                ),
              );
            name = heartbeat.name;
            report("online", name);
            await delay(intervalMs, undefined, { signal });
          }
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof LocalDeviceAccessError) throw error;
          report("connecting", name);
          await delay(failureDelay, undefined, { signal });
          failureDelay = Math.min(failureDelay * 2, 30_000);
        }
      }
    } finally {
      if (this.sessionId) {
        await this.request(
          "disconnect",
          { sessionId: this.sessionId },
          credential.token,
        ).catch(() => {});
        this.sessionId = undefined;
      }
    }
  }
  private async request(
    path: string,
    body: unknown,
    token?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetcher(
      new URL(`/api/local-devices/${path}`, this.url),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        credentials: "omit",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(5000),
      },
    );
    if ([401, 403, 404, 409].includes(response.status))
      throw new LocalDeviceAccessError(response.status);
    if (!response.ok)
      throw new Error("The device service is temporarily unavailable.");
    return response.json();
  }
}
