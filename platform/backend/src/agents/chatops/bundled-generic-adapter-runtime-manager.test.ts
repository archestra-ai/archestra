import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "@/test";
import type { BundledGenericAdapterCatalogEntry } from "./bundled-generic-adapter-catalog";
import {
    BundledGenericAdapterRuntimeManager,
    resolvePlatformRootFrom,
} from "./bundled-generic-adapter-runtime-manager";

class FakeChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    pid: number | undefined;
    kill = vi.fn();
}

const testCatalog = [
    {
        adapterId: "whatsapp",
        displayName: "WhatsApp",
        description: "Run the bundled WhatsApp ChatOps adapter process.",
        launch: {
            kind: "node-process",
            packageRelativePath: "integrations/chatops/baileys-whatsapp",
            entrypointRelativePath: "dist/bot.js",
        },
    },
] satisfies readonly BundledGenericAdapterCatalogEntry[];

describe("BundledGenericAdapterRuntimeManager", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("resolves the platform root from the compiled backend dist directory", () => {
        const backendRoot = process.cwd();
        const compiledBackendDistPath = path.join(backendRoot, "dist");

        expect(resolvePlatformRootFrom(compiledBackendDistPath)).toBe(
            path.resolve(backendRoot, ".."),
        );
    });

    test("builds the adapter when the bundled entrypoint is missing", async () => {
        const fileAccess = vi
            .fn()
            .mockRejectedValueOnce(new Error("missing"))
            .mockResolvedValueOnce(undefined);
        const packageFileRead = vi.fn().mockResolvedValue(`{
            "scripts": {
                "build": "tsc -p tsconfig.json"
            }
        }`);

        const buildProcess = new FakeChildProcess();
        const runtimeProcess = new FakeChildProcess();
        runtimeProcess.pid = 4242;

        const spawnProcess = vi
            .fn()
            .mockImplementationOnce(() => {
                queueMicrotask(() => {
                    buildProcess.emit("exit", 0, null);
                });
                return buildProcess as unknown as ChildProcess;
            })
            .mockImplementationOnce(() => {
                queueMicrotask(() => {
                    runtimeProcess.emit("spawn");
                });
                return runtimeProcess as unknown as ChildProcess;
            });

        const manager = new BundledGenericAdapterRuntimeManager({
            catalog: testCatalog,
            workspaceRootPath: "/workspace/platform",
            fileAccess,
            packageFileRead,
            spawnProcess,
        });

        await manager.initialize();
        const summary = await manager.startAdapter("whatsapp");

        expect(fileAccess).toHaveBeenCalledTimes(2);
        expect(packageFileRead).toHaveBeenCalledWith(
            "/workspace/platform/integrations/chatops/baileys-whatsapp/package.json",
            "utf8",
        );
        expect(spawnProcess).toHaveBeenNthCalledWith(
            1,
            process.platform === "win32" ? "cmd.exe" : "/bin/sh",
            process.platform === "win32"
                ? ["/d", "/s", "/c", "tsc -p tsconfig.json"]
                : ["-lc", "tsc -p tsconfig.json"],
            expect.objectContaining({
                cwd: "/workspace/platform/integrations/chatops/baileys-whatsapp",
                env: expect.objectContaining({
                    PATH: expect.stringContaining(
                        "/workspace/platform/integrations/chatops/baileys-whatsapp/node_modules/.bin",
                    ),
                }),
            }),
        );
        expect(spawnProcess).toHaveBeenNthCalledWith(
            2,
            process.execPath,
            [
                "--enable-source-maps",
                "/workspace/platform/integrations/chatops/baileys-whatsapp/dist/bot.js",
            ],
            expect.objectContaining({
                cwd: "/workspace/platform/integrations/chatops/baileys-whatsapp",
            }),
        );
        expect(summary.status).toBe("running");
        expect(summary.pid).toBe(4242);
    });
});