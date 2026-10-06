import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import OpenAppaNativeRoomModel from "@/models/openappa-native-room";
import { openappaDeclarations } from "@/openappa/declarations";
import { NATIVE_HELPER_INSTALL_ID } from "@/openappa/native-contract";
import { expect, test } from "@/test";
import routes from "./openappa-helpers.routes";

// Requires the Rust toolchain, not the ordinary backend unit-test environment.
// Run with ARCHESTRA_TEST_RUST_HELPER_INTEGRATION=true; this crosses real HTTP.
test.runIf(process.env.ARCHESTRA_TEST_RUST_HELPER_INTEGRATION === "true")(
  "real composed native policy consults the TS bridge and enforces admitted room facts",
  async ({ makeOrganization }) => {
    const org = await makeOrganization();
    config.openappa.enabled = true;
    const mapping: Record<string, string> = { "room-missing": "missing-room" };
    for (const [name, emails] of [
      ["room-a", ["alice@example.com", "bob@example.com"]],
      [
        "room-super",
        ["alice@example.com", "bob@example.com", "eve@example.com"],
      ],
      ["room-other", ["carol@example.com"]],
      ["room-subset", ["alice@example.com"]],
      ["room-unresolved", null],
    ] as const) {
      const registered = await OpenAppaNativeRoomModel.register({
        organizationId: org.id,
        facts: {
          ref: {
            provider: "slack",
            workspaceId: "native-engine-test",
            channelId: name,
            threadId: "",
          },
          trust: "suspicious",
          readers: emails
            ? { status: "resolved", emails: [...emails] }
            : { status: "unresolved" },
        },
      });
      if (registered.status !== "registered")
        throw new Error("room registration failed");
      mapping[name] = registered.snapshot.roomId;
    }
    const app = createFastifyInstance();
    const consulted = new Set<string>();
    const annotations: unknown[] = [];
    app.addHook("preHandler", async (request) => {
      const params = request.params as { externalName: string };
      if (params.externalName === "native.source-trust")
        annotations.push(request.body);
    });
    app.addHook("onResponse", async (request) => {
      const params = request.params as {
        installId: string;
        externalName: string;
      };
      if (params.installId === NATIVE_HELPER_INSTALL_ID)
        consulted.add(params.externalName);
    });
    await app.register(routes);
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const result = await promisify(execFile)(
        "cargo",
        [
          "test",
          "-p",
          "openappa_rs",
          "--lib",
          "native_boundary::native_contracts_narrow_audience_and_keep_a_suspicious_reply",
          "--",
          "--exact",
        ],
        {
          cwd: fileURLToPath(
            new URL("../../../../archestra-rs", import.meta.url),
          ),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CARGO_HOME: process.env.CARGO_HOME,
            RUSTUP_HOME: process.env.RUSTUP_HOME,
            APPA_NATIVE_TEST_PORT: new URL(address).port,
            APPA_NATIVE_TEST_TOKEN: openappaDeclarations.bridgeToken,
            APPA_NATIVE_TEST_ROOMS: JSON.stringify(mapping),
          },
          timeout: 180_000,
        },
      ).catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(
          `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}\n${JSON.stringify(annotations)}`,
        );
      });
      expect(result.stdout).toContain("1 passed; 0 failed");
      expect(consulted).toEqual(
        new Set([
          "native-room",
          "native",
          "native.source-trust",
          "native.reply-check",
        ]),
      );
      const missingRank = structuredClone(annotations[0]) as {
        declaration: Record<string, unknown>;
      };
      delete missingRank.declaration.trust_ranks;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/openappa/helpers/${NATIVE_HELPER_INSTALL_ID}/native.source-trust`,
            headers: {
              authorization: `Bearer ${openappaDeclarations.bridgeToken}`,
            },
            payload: missingRank,
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  },
  180_000,
);
