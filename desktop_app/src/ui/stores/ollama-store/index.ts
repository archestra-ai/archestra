import { ModelResponse } from 'ollama/browser';
import { create } from 'zustand';

import config from '@ui/config';
import {
  OllamaModelDownloadProgress,
  OllamaRequiredModelStatus,
  getOllamaRequiredModelsStatus,
} from '@ui/lib/clients/archestra/api/gen';
import { ArchestraOllamaClient } from '@ui/lib/clients/ollama';
import { OllamaLocalStorage } from '@ui/lib/localStorage';
import websocketService from '@ui/lib/websocket';
import { useStatusBarStore } from '@ui/stores/status-bar-store';

import { AVAILABLE_MODELS } from './available_models';

const ollamaClient = new ArchestraOllamaClient({ host: config.archestra.ollamaProxyUrl });

interface OllamaState {
  installedModels: ModelResponse[];
  downloadProgress: Record<string, number>;
  loadingInstalledModels: boolean;
  loadingInstalledModelsError: Error | null;
  selectedModel: string | undefined;
  modelsBeingDownloaded: Set<string>;

  requiredModelsStatus: OllamaRequiredModelStatus[];
  requiredModelsDownloadProgress: Record<string, OllamaModelDownloadProgress>;
  loadingRequiredModels: boolean;
}

interface OllamaActions {
  downloadModel: (fullModelName: string) => Promise<void>;
  fetchInstalledModels: () => Promise<void>;
  setSelectedModel: (model: string) => void;

  fetchRequiredModelsStatus: () => Promise<void>;
  updateRequiredModelDownloadProgress: (progress: OllamaModelDownloadProgress) => void;
}

type OllamaStore = OllamaState & OllamaActions;

export const useOllamaStore = create<OllamaStore>((set, get) => ({
  // State
  installedModels: [],
  downloadProgress: {},
  loadingInstalledModels: false,
  loadingInstalledModelsError: null,
  selectedModel: OllamaLocalStorage.getSelectedModel() || undefined,
  modelsBeingDownloaded: new Set(),
  requiredModelsStatus: [],
  requiredModelsDownloadProgress: {},
  loadingRequiredModels: true,

  // Actions
  fetchInstalledModels: async () => {
    const MAX_RETRIES = 30;
    const RETRY_DELAY_MILLISECONDS = 1000;
    let retries = 0;

    const attemptConnection = async (): Promise<boolean> => {
      try {
        const { selectedModel } = get();
        const { models } = await ollamaClient.list();
        set({ installedModels: models });

        // Don't auto-select a model - let user choose
        // const firstInstalledModel = models[0];
        // if (!selectedModel && firstInstalledModel && firstInstalledModel.model) {
        //   get().setSelectedModel(firstInstalledModel.model);
        // }

        return true;
      } catch (error) {
        return false;
      }
    };

    set({ loadingInstalledModels: true, loadingInstalledModelsError: null });

    // Keep trying to connect until successful or max retries reached
    while (retries < MAX_RETRIES) {
      const connected = await attemptConnection();
      if (connected) {
        set({ loadingInstalledModels: false });
        return;
      }

      retries++;
      if (retries < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MILLISECONDS));
      }
    }

    // If we've exhausted all retries, set error state
    set({
      loadingInstalledModels: false,
      loadingInstalledModelsError: new Error('Failed to connect to Ollama after maximum retries'),
    });
  },

  downloadModel: async (fullModelName: string) => {
    try {
      // Update progress and downloading set
      set((state) => ({
        downloadProgress: { ...state.downloadProgress, [fullModelName]: 0.1 },
        modelsBeingDownloaded: new Set([...state.modelsBeingDownloaded, fullModelName]),
      }));

      // Use the new backend endpoint that sends WebSocket progress
      const response = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: fullModelName }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to download model: ${error}`);
      }

      // The WebSocket events will update the progress via the subscription below
      // Just wait for completion
      const result = await response.json();
      console.log('Model download completed:', result);

      await get().fetchInstalledModels();
    } catch (error) {
      console.error('Failed to download model:', error);
    } finally {
      set((state) => {
        const newModelsBeingDownloaded = new Set(state.modelsBeingDownloaded);
        newModelsBeingDownloaded.delete(fullModelName);

        const newDownloadProgress = { ...state.downloadProgress };
        delete newDownloadProgress[fullModelName];

        return {
          modelsBeingDownloaded: newModelsBeingDownloaded,
          downloadProgress: newDownloadProgress,
        };
      });
    }
  },

  setSelectedModel: async (model: string) => {
    const previousModel = get().selectedModel;

    // Track model switching in StatusBar
    const statusBarStore = useStatusBarStore.getState();

    if (previousModel && previousModel !== model) {
      // Show unloading previous model
      statusBarStore.updateTask('ollama-model-switch', {
        id: 'ollama-model-switch',
        type: 'model',
        title: 'Switching Model',
        description: `Unloading ${previousModel}...`,
        status: 'active',
        timestamp: Date.now(),
      });

      // Unload the previous model by setting keep_alive to 0
      try {
        await fetch('/llm/ollama/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: previousModel,
            keep_alive: 0,
          }),
        });
      } catch (error) {
        console.error('Failed to unload previous model:', error);
      }
    }

    // Update selected model
    OllamaLocalStorage.setSelectedModel(model);
    set({ selectedModel: model });

    // Show loading new model
    statusBarStore.updateTask('ollama-model-switch', {
      id: 'ollama-model-switch',
      type: 'model',
      title: 'Loading Model',
      description: `Loading ${model} into memory...`,
      status: 'active',
      timestamp: Date.now(),
    });

    // Pre-load the new model with keep_alive to keep it in memory
    try {
      await fetch('/llm/ollama/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '',
          keep_alive: '30m', // Keep model loaded for 30 minutes
        }),
      });

      // Mark as completed
      statusBarStore.updateTask('ollama-model-switch', {
        status: 'completed',
        description: `${model} loaded`,
      });
      setTimeout(() => statusBarStore.removeTask('ollama-model-switch'), 2000);
    } catch (error) {
      console.error('Failed to load new model:', error);
      statusBarStore.updateTask('ollama-model-switch', {
        status: 'error',
        description: 'Failed to load model',
        error: error instanceof Error ? error.message : String(error),
      });
      setTimeout(() => statusBarStore.removeTask('ollama-model-switch'), 5000);
    }
  },

  fetchRequiredModelsStatus: async () => {
    try {
      const { data } = await getOllamaRequiredModelsStatus();
      if (data) {
        set({ requiredModelsStatus: data.models, loadingRequiredModels: false });
      }
    } catch (error) {
      console.error('Failed to fetch required models:', error);
      set({ loadingRequiredModels: false });
    }
  },

  updateRequiredModelDownloadProgress: (progress: OllamaModelDownloadProgress) => {
    set((state) => ({
      requiredModelsDownloadProgress: {
        ...state.requiredModelsDownloadProgress,
        [progress.model]: progress,
      },
      // Also update the general download progress for user-initiated downloads
      downloadProgress: state.modelsBeingDownloaded.has(progress.model)
        ? {
            ...state.downloadProgress,
            [progress.model]: progress.progress,
          }
        : state.downloadProgress,
    }));

    // When download is completed, refresh the installed models list
    if (progress.status === 'completed') {
      // Add a small delay to ensure Ollama has registered the model
      setTimeout(() => {
        get().fetchInstalledModels();
        get().fetchRequiredModelsStatus();
      }, 500);
    }
  },
}));

// Fetch installed/required-models-status on store creation
useOllamaStore.getState().fetchInstalledModels();
useOllamaStore.getState().fetchRequiredModelsStatus();

websocketService.subscribe('ollama-model-download-progress', ({ payload }) => {
  useOllamaStore.getState().updateRequiredModelDownloadProgress(payload);
});

// Computed values as selectors
export const useAvailableModels = () => AVAILABLE_MODELS;
export const useAllAvailableModelLabels = () => {
  return Array.from(new Set(AVAILABLE_MODELS.flatMap((model) => model.labels)));
};
