import config from "@/config";
import logger from "@/logging";
import type {
  KnowledgeGraphConfig,
  KnowledgeGraphProvider,
  KnowledgeGraphProviderType,
} from "@/types/knowledge-graph";

import { LightRAGProvider } from "./lightrag-provider";

export type {
  KnowledgeGraphConfig,
  KnowledgeGraphProvider,
  KnowledgeGraphProviderType,
} from "@/types/knowledge-graph";
export { LightRAGProvider } from "./lightrag-provider";

/**
 * Singleton instance of the configured knowledge graph provider
 */
let knowledgeGraphProviderInstance: KnowledgeGraphProvider | null = null;

/**
 * Flag to track if we've already attempted initialization
 * Prevents repeated initialization attempts for unconfigured providers
 */
let providerInitializationAttempted = false;

/**
 * Promise to track ongoing provider creation
 * Prevents race conditions when multiple callers request the provider simultaneously
 */
let providerCreationPromise: Promise<KnowledgeGraphProvider | null> | null =
  null;

/**
 * Get the knowledge graph provider configuration from config
 */
export function getKnowledgeGraphConfig(): KnowledgeGraphConfig {
  return config.knowledgeGraph;
}

/**
 * Check if the knowledge graph feature is enabled
 */
export function isKnowledgeGraphEnabled(): boolean {
  const providerConfig = getKnowledgeGraphConfig();
  return providerConfig.provider !== undefined;
}

/**
 * Get the configured knowledge graph provider type
 */
export function getKnowledgeGraphProviderType():
  | KnowledgeGraphProviderType
  | undefined {
  return getKnowledgeGraphConfig().provider;
}

/**
 * Create a knowledge graph provider instance based on configuration
 */
export function createKnowledgeGraphProvider(
  providerType: KnowledgeGraphProviderType,
  providerConfig: KnowledgeGraphConfig,
): KnowledgeGraphProvider {
  switch (providerType) {
    case "lightrag": {
      if (!providerConfig.lightrag) {
        throw new Error("LightRAG provider configuration is missing");
      }
      return new LightRAGProvider(providerConfig.lightrag);
    }
    default:
      throw new Error(`Unknown knowledge graph provider type: ${providerType}`);
  }
}

/**
 * Internal function to create the provider instance
 * This handles the actual creation logic and is used by getKnowledgeGraphProviderAsync
 */
function createProviderInstance(): KnowledgeGraphProvider | null {
  const providerConfig = getKnowledgeGraphConfig();
  if (!providerConfig.provider) {
    providerInitializationAttempted = true;
    return null;
  }

  try {
    const provider = createKnowledgeGraphProvider(
      providerConfig.provider,
      providerConfig,
    );

    if (!provider.isConfigured()) {
      logger.warn(
        { provider: providerConfig.provider },
        "[KnowledgeGraph] Provider is not fully configured",
      );
      providerInitializationAttempted = true;
      return null;
    }

    // Only cache if successfully configured
    knowledgeGraphProviderInstance = provider;
    providerInitializationAttempted = true;
    return knowledgeGraphProviderInstance;
  } catch (error) {
    logger.error(
      {
        provider: providerConfig.provider,
        error: error instanceof Error ? error.message : String(error),
      },
      "[KnowledgeGraph] Failed to create knowledge graph provider",
    );
    providerInitializationAttempted = true;
    return null;
  }
}

/**
 * Get the configured knowledge graph provider instance (singleton) - async version
 * This version is safe for concurrent calls during initialization
 * Returns null if no provider is configured
 */
export async function getKnowledgeGraphProviderAsync(): Promise<KnowledgeGraphProvider | null> {
  // Return cached instance if available
  if (knowledgeGraphProviderInstance) {
    return knowledgeGraphProviderInstance;
  }

  // If we've already tried and failed, don't retry
  if (providerInitializationAttempted) {
    return null;
  }

  // If creation is already in progress, wait for it to complete
  if (providerCreationPromise) {
    return providerCreationPromise;
  }

  // Start creation and store the promise to prevent concurrent creation attempts
  providerCreationPromise = Promise.resolve().then(() => {
    // Double-check after acquiring the "lock"
    if (knowledgeGraphProviderInstance) {
      return knowledgeGraphProviderInstance;
    }
    if (providerInitializationAttempted) {
      return null;
    }
    return createProviderInstance();
  });

  try {
    return await providerCreationPromise;
  } finally {
    // Clear the promise once creation is complete
    providerCreationPromise = null;
  }
}

/**
 * Get the configured knowledge graph provider instance (singleton) - sync version
 * Note: For race-condition-safe initialization, use getKnowledgeGraphProviderAsync()
 * This synchronous version returns null if the provider hasn't been initialized yet
 * Returns null if no provider is configured
 */
export function getKnowledgeGraphProvider(): KnowledgeGraphProvider | null {
  // Return cached instance if available
  if (knowledgeGraphProviderInstance) {
    return knowledgeGraphProviderInstance;
  }

  // If we've already tried and failed, don't retry
  if (providerInitializationAttempted) {
    return null;
  }

  // If creation is in progress, return null (caller should use async version)
  if (providerCreationPromise) {
    return null;
  }

  return createProviderInstance();
}

/**
 * Initialize the knowledge graph provider (call on server startup)
 * Uses the async version to handle potential race conditions during startup
 */
export async function initializeKnowledgeGraphProvider(): Promise<void> {
  const provider = await getKnowledgeGraphProviderAsync();
  if (!provider) {
    logger.info(
      "[KnowledgeGraph] No knowledge graph provider configured, skipping initialization",
    );
    return;
  }

  try {
    await provider.initialize();
    logger.info(
      { provider: provider.providerId },
      "[KnowledgeGraph] Knowledge graph provider initialized successfully",
    );
  } catch (error) {
    logger.error(
      {
        provider: provider.providerId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[KnowledgeGraph] Failed to initialize knowledge graph provider",
    );
    // Don't throw - allow server to start even if knowledge graph provider fails
  }
}

/**
 * Cleanup the knowledge graph provider (call on server shutdown)
 */
export async function cleanupKnowledgeGraphProvider(): Promise<void> {
  if (knowledgeGraphProviderInstance) {
    try {
      await knowledgeGraphProviderInstance.cleanup();
      logger.info(
        { provider: knowledgeGraphProviderInstance.providerId },
        "[KnowledgeGraph] Knowledge graph provider cleaned up",
      );
    } catch (error) {
      logger.warn(
        {
          provider: knowledgeGraphProviderInstance.providerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[KnowledgeGraph] Error during knowledge graph provider cleanup",
      );
    }
    knowledgeGraphProviderInstance = null;
  }
  // Reset the initialization flags to allow reinitialization after cleanup
  providerInitializationAttempted = false;
  providerCreationPromise = null;
}

/**
 * Ingest a document into the knowledge graph
 * This is the main entry point for document ingestion from chat uploads
 *
 * @param content - The document content to ingest
 * @param filename - Optional filename for the document
 * @param metadata - Optional metadata to associate with the document
 * @returns true if ingestion was successful/queued, false otherwise
 */
export async function ingestDocument(params: {
  content: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const provider = getKnowledgeGraphProvider();

  if (!provider) {
    // Knowledge graph not configured - silently skip
    return false;
  }

  try {
    const result = await provider.insertDocument(params);

    if (result.status === "failed") {
      logger.warn(
        {
          filename: params.filename,
          error: result.error,
        },
        "[KnowledgeGraph] Document ingestion failed",
      );
      return false;
    }

    logger.info(
      {
        filename: params.filename,
        documentId: result.documentId,
        status: result.status,
      },
      "[KnowledgeGraph] Document ingested successfully",
    );
    return true;
  } catch (error) {
    logger.error(
      {
        filename: params.filename,
        error: error instanceof Error ? error.message : String(error),
      },
      "[KnowledgeGraph] Error during document ingestion",
    );
    return false;
  }
}

/**
 * Get knowledge graph provider information for the features endpoint
 */
export function getKnowledgeGraphProviderInfo(): {
  enabled: boolean;
  provider: KnowledgeGraphProviderType | undefined;
  displayName: string | undefined;
} {
  const provider = getKnowledgeGraphProvider();

  if (!provider) {
    return {
      enabled: false,
      provider: undefined,
      displayName: undefined,
    };
  }

  return {
    enabled: true,
    provider: provider.providerId,
    displayName: provider.displayName,
  };
}
