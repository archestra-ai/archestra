import { vi } from "vitest";
import { createFastifyInstance } from "@/server";
import { describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

const { listSummariesMock, startAdapterMock } = vi.hoisted(() => ({
    listSummariesMock: vi.fn(),
    startAdapterMock: vi.fn(),
}));

vi.mock("@/agents/chatops/bundled-generic-adapter-runtime-manager", () => ({
    bundledGenericAdapterRuntimeManager: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        listSummaries: listSummariesMock,
        startAdapter: startAdapterMock,
    },
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
    chatOpsManager: {
        reinitialize: vi.fn(),
        getMSTeamsProvider: vi.fn(() => null),
        getSlackProvider: vi.fn(() => null),
        getChatOpsProvider: vi.fn(() => null),
        processMessage: vi.fn(),
        getAccessibleChatopsAgents: vi.fn(() => []),
        discoverChannels: vi.fn(),
    },
}));

vi.mock("botframework-connector", () => ({
    MicrosoftAppCredentials: class {
        getToken() {
            return Promise.resolve("mock-token");
        }
    },
}));

vi.mock("@slack/web-api", () => ({
    WebClient: class {
        auth = { test: () => Promise.resolve({ ok: true }) };
        apps = {
            connections: { open: () => Promise.resolve({ ok: true }) },
        };
    },
}));

describe("bundled ChatOps adapter routes", () => {
    test("GET /api/chatops/generic/builtin-adapters returns bundled adapter summaries", async () => {
        listSummariesMock.mockReturnValueOnce([
            {
                adapterId: "whatsapp",
                displayName: "WhatsApp",
                description: "Run the bundled WhatsApp ChatOps adapter process.",
                status: "stopped",
                pid: null,
                lastStartedAt: null,
                lastExitAt: null,
                errorMessage: null,
            },
        ]);

        const app = createFastifyInstance();
        await app.register(chatopsRoutes);

        const response = await app.inject({
            method: "GET",
            url: "/api/chatops/generic/builtin-adapters",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            adapters: [
                {
                    adapterId: "whatsapp",
                    displayName: "WhatsApp",
                    description: "Run the bundled WhatsApp ChatOps adapter process.",
                    status: "stopped",
                    pid: null,
                    lastStartedAt: null,
                    lastExitAt: null,
                    errorMessage: null,
                },
            ],
        });

        await app.close();
    });

    test("POST /api/chatops/generic/builtin-adapters/:adapterId/start starts the adapter", async () => {
        startAdapterMock.mockResolvedValueOnce({
            adapterId: "whatsapp",
            displayName: "WhatsApp",
            description: "Run the bundled WhatsApp ChatOps adapter process.",
            status: "running",
            pid: 4242,
            lastStartedAt: "2026-05-01T12:00:00.000Z",
            lastExitAt: null,
            errorMessage: null,
        });

        const app = createFastifyInstance();
        await app.register(chatopsRoutes);

        const response = await app.inject({
            method: "POST",
            url: "/api/chatops/generic/builtin-adapters/whatsapp/start",
        });

        expect(response.statusCode).toBe(200);
        expect(startAdapterMock).toHaveBeenCalledWith("whatsapp");
        expect(response.json()).toEqual({
            adapterId: "whatsapp",
            displayName: "WhatsApp",
            description: "Run the bundled WhatsApp ChatOps adapter process.",
            status: "running",
            pid: 4242,
            lastStartedAt: "2026-05-01T12:00:00.000Z",
            lastExitAt: null,
            errorMessage: null,
        });

        await app.close();
    });
});