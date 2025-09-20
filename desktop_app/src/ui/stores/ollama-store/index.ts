import { ModelResponse } from 'ollama/browser';
import { create } from 'zustand';

import { SYSTEM_MODEL_NAMES } from '@constants';
import config from '@ui/config';
import {
  OllamaModelDownloadProgress,
  OllamaRequiredModelStatus,
  getOllamaRequiredModelsStatus,
  pullOllamaModel,
  removeOllamaModel,
} from '@ui/lib/clients/archestra/api/gen';
import { ArchestraOllamaClient } from '@ui/lib/clients/ollama';
import websocketService from '@ui/lib/websocket';
import { useStatusBarStore } from '@ui/stores/status-bar-store';

import { AVAILABLE_MODELS } from './available_models';

const { ollamaProxyUrl } = config.archestra;

const ollamaClient = new ArchestraOllamaClient({ host: ollamaProxyUrl });

interface OllamaState {
  installedModels: ModelResponse[];
  downloadProgress: Record<string, number>;
  loadingInstalledModels: boolean;
  loadingInstalledModelsError: Error | null;
  modelsBeingDownloaded: Set<string>;

  requiredModelsStatus: OllamaRequiredModelStatus[];
  requiredModelsDownloadProgress: Record<string, OllamaModelDownloadProgress>;
  loadingRequiredModels: boolean;
}

interface OllamaActions {
  downloadModel: (fullModelName: string) => Promise<void>;
  uninstallModel: (fullModelName: string) => Promise<void>;
  fetchInstalledModels: () => Promise<void>;

  fetchRequiredModelsStatus: () => Promise<void>;
  updateRequiredModelDownloadProgress: (progress: OllamaModelDownloadProgress) => void;

  conditionallyHandleOllamaModelChange: (previousModelName: string | undefined, newModelName: string) => Promise<void>;
}

type OllamaStore = OllamaState & OllamaActions;

const preloadOllamaModel = async (model: string, keepAlive: string) =>
  fetch(`${ollamaProxyUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      keep_alive: keepAlive,
    }),
  });

export const useOllamaStore = create<OllamaStore>((set, get) => ({
  // State
  installedModels: [],
  downloadProgress: {},
  loadingInstalledModels: false,
  loadingInstalledModelsError: null,
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
        const { models } = await ollamaClient.list();
        set({ installedModels: models });

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
      const { data } = await pullOllamaModel({
        body: {
          model: fullModelName,
        },
      });

      if (!data) {
        throw new Error('Failed to download model');
      } else if (!data.success) {
        throw new Error(`Failed to download model: ${data.message}`);
      }

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

  uninstallModel: async (fullModelName: string) => {
    const statusBarStore = useStatusBarStore.getState();
    const taskId = `ollama-uninstall-${fullModelName}`;
    let finalizeTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;

    try {
      // Show uninstall task
      statusBarStore.updateTask(taskId, {
        id: taskId,
        type: 'model',
        title: 'Model',
        description: `Uninstalling ${fullModelName} (1/5)...`,
        progress: 1,
        status: 'active',
        timestamp: Date.now(),
      });

      // Simulate step-wise progress while backend processes the uninstall
      // Steps: 1/5 -> 2/5 -> 3/5 -> 4/5 -> 5/5 (90%)
      const stepTargets = [5, 25, 50, 75, 90];
      let simulated = 1;
      let stepIndex = 0;

      progressTimer = setInterval(() => {
        simulated = Math.min(simulated + 2, 90);
        if (stepIndex < stepTargets.length && simulated >= stepTargets[stepIndex]) {
          statusBarStore.updateTask(taskId, {
            progress: simulated,
            description: `Uninstalling ${fullModelName} (${stepIndex + 1}/5)...`,
          });

          stepIndex++;
        } else {
          statusBarStore.updateTask(taskId, { progress: simulated });
        }

        if (simulated >= 90) {
          clearInterval(progressTimer);
        }
      }, 200);

      const { data } = await removeOllamaModel({
        path: {
          modelName: fullModelName,
        },
      });

      if (data && !data.success) {
        throw new Error(data.message || `Failed to uninstall ${fullModelName}`);
      }

      // Refresh the installed models list after successful uninstall
      await get().fetchInstalledModels();

      // Finish progress and show a brief success state using the same active layout
      clearInterval(progressTimer);
      // Smoothly animate to 100% keeping the uninstalling copy
      finalizeTimer = setInterval(() => {
        simulated = Math.min(simulated + 2, 100);

        if (simulated < 100) {
          statusBarStore.updateTask(taskId, {
            progress: simulated,
            description: `Uninstalling ${fullModelName} (5/5)...`,
          });
        } else {
          clearInterval(finalizeTimer);

          statusBarStore.updateTask(taskId, { progress: 100 });

          // Keep as active briefly so it shows in the collapsed header
          statusBarStore.updateTask(taskId, {
            status: 'active',
            description: `Uninstalled ${fullModelName} successfully`,
          });

          setTimeout(() => statusBarStore.removeTask(taskId), 3000);
        }
      }, 60);
    } catch (error) {
      console.error('Failed to uninstall model:', error);

      clearInterval(progressTimer);

      if (finalizeTimer) {
        clearInterval(finalizeTimer);
      }

      statusBarStore.updateTask(taskId, {
        status: 'error',
        description: `Failed to uninstall ${fullModelName}`,
        error: error instanceof Error ? error.message : String(error),
      });

      setTimeout(() => statusBarStore.removeTask(taskId), 5000);

      throw error;
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

  conditionallyHandleOllamaModelChange: async (previousModelName: string | undefined, newModelName: string) => {
    const { installedModels } = get();
    const statusBarStore = useStatusBarStore.getState();

    const previousModelIsOllamaModel = installedModels.some((model) => model.model === previousModelName);
    const newModelIsOllamaModel = installedModels.some((model) => model.model === newModelName);

    if (previousModelName && previousModelIsOllamaModel) {
      statusBarStore.updateTask('ollama-model-switch', {
        id: 'ollama-model-switch',
        type: 'model',
        title: 'Switching Model',
        description: `Unloading ${previousModelName}...`,
        status: 'active',
        timestamp: Date.now(),
      });

      try {
        // Unload the previous model by setting keep_alive to 0
        await preloadOllamaModel(previousModelName, '0');
      } catch (error) {
        console.error('Failed to unload previous model:', error);
      }

      setTimeout(() => statusBarStore.removeTask('ollama-model-switch'), 5000);
    }

    if (newModelIsOllamaModel) {
      // Show loading new model
      statusBarStore.updateTask('ollama-model-switch', {
        id: 'ollama-model-switch',
        type: 'model',
        title: 'Loading Model',
        description: `Loading ${newModelName} into memory...`,
        status: 'active',
        timestamp: Date.now(),
      });

      try {
        // Pre-load the new model with keep_alive to keep it in memory (for 30 minutes)
        await preloadOllamaModel(newModelName, '30m');

        statusBarStore.updateTask('ollama-model-switch', {
          status: 'completed',
          description: `${newModelName} loaded`,
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

// Selector for user-selectable models (filters out system models)
export const useUserSelectableModels = () => {
  const { installedModels } = useOllamaStore();
  return getUserSelectableModels(installedModels);
};

function getUserSelectableModels(models: ModelResponse[] = []): ModelResponse[] {
  return models.filter((model) => !SYSTEM_MODEL_NAMES.includes(model.model));
}
