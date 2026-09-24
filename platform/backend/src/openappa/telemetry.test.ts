import { vi } from "vitest";
import config from "@/config";
import * as database from "@/database";
import logger from "@/logging";
import { expect, test } from "@/test";
import { evaluateToolCalls, flushOpenappaTelemetry } from "./service";

// Only the native process boundary is mocked. Policy composition still uses
// the real effective-policy store and the migrated database fixtures.
const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  flushOpenappaTelemetry: vi.fn(),
  dispatchHook: vi.fn(async () => JSON.stringify({ decision: "allow_call" })),
  listBundledOpenappaBatteries: vi.fn(async () => []),
  parseOpenappaDeclarations: vi.fn(async () => ({
    include: [],
    serverAliases: [],
    credentials: [],
    routedAnnotators: [],
    errors: [],
  })),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/logging");

test("embedded export requires opt-in, inherits collector auth, and flushes only a loaded addon", async ({
  makeOrganization,
}) => {
  const organization = await makeOrganization();
  const connectionString = vi
    .spyOn(database, "getDatabaseConnectionString")
    .mockReturnValue("postgresql://test:test@localhost/test");
  const otel = config.observability.otel;
  const previous = {
    enabled: otel.openappaEnabled,
    exporter: otel.traceExporter,
    appa: config.openappa,
  };
  try {
    config.openappa = { ...config.openappa, enabled: true, yellEnabled: false };
    await flushOpenappaTelemetry();
    expect(native.initializeOpenappa).not.toHaveBeenCalled();
    expect(native.flushOpenappaTelemetry).not.toHaveBeenCalled();

    const check = () =>
      evaluateToolCalls(
        {
          organization_id: organization.id,
          session_id: "telemetry-test",
          caller_id: "user:fixture",
        },
        [{ id: "call-1", name: "read_file", arguments: {} }],
        { canonicalize: (name) => name },
      );
    // Failed initialization resets the lazy binding. Exercise both states on
    // retry, then initialize successfully and exercise graceful shutdown.
    for (const enabled of [false, true]) {
      otel.openappaEnabled = enabled;
      otel.traceExporter = {
        url: "https://collector.example.test/custom/v1/traces",
        headers: { Authorization: "Bearer collector-test-only" },
      };
      native.initializeOpenappa.mockRejectedValueOnce(
        new Error("test initialization failure"),
      );
      await expect(check()).rejects.toMatchObject({
        cause: { message: "test initialization failure" },
      });
      expect(native.initializeOpenappa).toHaveBeenCalledTimes(enabled ? 2 : 1);
      const options = native.initializeOpenappa.mock.lastCall?.[4];
      if (enabled) {
        expect(options).toEqual({
          tracesEndpoint: otel.traceExporter.url,
          headers: otel.traceExporter.headers,
          instanceId: expect.stringMatching(/:\d+$/),
        });
      } else {
        expect(options).toBeUndefined();
      }
    }
    expect(await check()).toEqual([{ kind: "allow" }]);
    await flushOpenappaTelemetry();
    expect(native.flushOpenappaTelemetry).toHaveBeenCalledTimes(1);
    native.flushOpenappaTelemetry.mockRejectedValueOnce(
      new Error("secret collector credential"),
    );
    await expect(flushOpenappaTelemetry()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenLastCalledWith(
      "OpenAPPA telemetry flush failed",
    );
  } finally {
    connectionString.mockRestore();
    config.openappa = previous.appa;
    otel.openappaEnabled = previous.enabled;
    otel.traceExporter = previous.exporter;
  }
});
