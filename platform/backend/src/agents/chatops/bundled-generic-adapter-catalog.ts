import type { BundledChatOpsAdapterId } from "@/types";

export interface BundledGenericAdapterLaunchDescriptor {
    kind: "node-process";
    packageRelativePath: string;
    entrypointRelativePath: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface BundledGenericAdapterCatalogEntry {
    adapterId: BundledChatOpsAdapterId;
    displayName: string;
    description: string;
    launch: BundledGenericAdapterLaunchDescriptor;
}

export const bundledGenericAdapterCatalog = [
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