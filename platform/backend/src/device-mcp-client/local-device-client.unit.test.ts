import { describe, expect, test, vi } from "vitest";
import {
  LocalDeviceAccessError,
  LocalDeviceClient,
  type LocalDeviceCredential,
} from "./local-device-client";

const id = "00000000-0000-4000-8000-000000000001";
const session = "00000000-0000-4000-8000-000000000002";
const credential: LocalDeviceCredential = {
  version: 1,
  deviceId: id,
  token: "private-device-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  name: "Work computer",
  url: "https://deployment.example",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("presence-only local device client", () => {
  test("does not redeem or receive a credential when the native approval is declined", async () => {
    const paths: string[] = [];
    const client = new LocalDeviceClient(credential.url, async (input) => {
      paths.push(new URL(String(input)).pathname);
      return json({
        deviceId: id,
        name: credential.name,
        organizationName: "Example",
        ownerName: "User",
        capabilities: ["local_mcp"],
      });
    });
    await expect(
      client.enroll(
        "a".repeat(43),
        { platform: "darwin", arch: "arm64", appVersion: "1" },
        async () => false,
      ),
    ).rejects.toThrow("cancelled");
    expect(paths).toEqual(["/api/local-devices/inspect"]);
  });
  test("sends presence metadata only after approval and authenticates heartbeats without cookies", async () => {
    const requests: { path: string; init: RequestInit | undefined }[] = [];
    const abort = new AbortController();
    const client = new LocalDeviceClient(
      credential.url,
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, init });
        if (path.endsWith("inspect"))
          return json({
            deviceId: id,
            name: credential.name,
            organizationName: "Example",
            ownerName: "User",
            capabilities: ["local_mcp"],
          });
        if (path.endsWith("redeem")) return json(credential);
        if (path.endsWith("session")) return json({ sessionId: session });
        return json({ success: true, name: "Renamed computer" });
      },
    );
    const enrolled = await client.enroll(
      "a".repeat(43),
      { platform: "win32", arch: "x64", appVersion: "1.5" },
      async () => true,
    );
    await client.run(
      enrolled,
      (state, name) => {
        expect(state).toBe("online");
        expect(name).toBe("Renamed computer");
        abort.abort();
      },
      abort.signal,
      1,
    );
    const redeem = requests.find((request) => request.path.endsWith("redeem"));
    expect(JSON.parse(String(redeem?.init?.body))).toEqual({
      code: "a".repeat(43),
      platform: "win32",
      arch: "x64",
      appVersion: "1.5",
    });
    const heartbeat = requests.find((request) =>
      request.path.endsWith("heartbeat"),
    );
    expect(heartbeat?.init?.headers).toMatchObject({
      Authorization: `Bearer ${credential.token}`,
    });
    expect(heartbeat?.init?.credentials).toBe("omit");
    expect(requests.at(-1)?.path).toBe("/api/local-devices/disconnect");
    expect(
      requests.every((request) => !request.path.includes("device-mcp")),
    ).toBe(true);
  });
  test("reconnects after a temporary outage with a new session, without re-enrolling", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const paths: string[] = [];
      const reports: string[] = [];
      const abort = new AbortController();
      const client = new LocalDeviceClient(credential.url, async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path.endsWith("session")) {
          if (++attempts === 1)
            throw new Error("network temporarily unavailable");
          return json({ sessionId: session });
        }
        return json({ success: true, name: credential.name });
      });
      const running = client.run(
        credential,
        (state) => {
          reports.push(state);
          if (state === "online") abort.abort();
        },
        abort.signal,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await running;
      expect(reports).toEqual(["connecting", "online"]);
      expect(attempts).toBe(2);
      expect(paths.some((path) => path.endsWith("redeem"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  test.each([
    401, 403, 404, 409,
  ])("stops after access failure %s and distinguishes stale sessions from revoked credentials", async (status) => {
    const client = new LocalDeviceClient(credential.url, async () =>
      json({}, status),
    );
    try {
      await client.run(credential, () => {}, new AbortController().signal, 1);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalDeviceAccessError);
      expect((error as LocalDeviceAccessError).credentialInvalid).toBe(
        status !== 409,
      );
    }
  });
  test("refuses expired credentials before starting a session", async () => {
    let calls = 0;
    const client = new LocalDeviceClient(credential.url, async () => {
      calls++;
      return json({});
    });
    await expect(
      client.run(
        { ...credential, expiresAt: "2000-01-01T00:00:00.000Z" },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(LocalDeviceAccessError);
    expect(calls).toBe(0);
  });
  test("rejects redirects and unsafe server origins", () => {
    expect(() => new LocalDeviceClient("http://remote.example")).toThrow();
    expect(
      () => new LocalDeviceClient("https://deployment.example/path"),
    ).toThrow();
  });
});
