import { create } from 'zustand';

import {
  type CloudProviderWithConfig,
  type SupportedCloudProviderModel,
  type SupportedCloudProviders,
  configureCloudProvider,
  deleteCloudProvider,
  getAvailableCloudProviders,
  getCloudProviderModels,
} from '@ui/lib/clients/archestra/api/gen';
import webSocketService from '@ui/lib/websocket';

interface CloudProvidersStore {
  cloudProviders: CloudProviderWithConfig[];
  loadingCloudProviders: boolean;

  availableCloudProviderModels: SupportedCloudProviderModel[];
  loadingAvailableCloudProviderModels: boolean;

  loadCloudProviders: () => Promise<void>;
  configureCloudProvider: (type: SupportedCloudProviders, apiKey: string) => Promise<void>;
  deleteCloudProvider: (type: SupportedCloudProviders) => Promise<void>;
  getAvailableCloudProviderModels: () => Promise<void>;
}

export const useCloudProvidersStore = create<CloudProvidersStore>((set, get) => ({
  cloudProviders: [],
  loadingCloudProviders: false,

  availableCloudProviderModels: [],
  loadingAvailableCloudProviderModels: false,

  loadCloudProviders: async () => {
    set({ loadingCloudProviders: true });
    try {
      const { data } = await getAvailableCloudProviders();
      set({ cloudProviders: data });
    } finally {
      set({ loadingCloudProviders: false });
    }
  },

  configureCloudProvider: async (type: SupportedCloudProviders, apiKey: string) => {
    await configureCloudProvider({ body: { type, apiKey } });
    await get().loadCloudProviders();
    await get().getAvailableCloudProviderModels();
  },

  deleteCloudProvider: async (type: SupportedCloudProviders) => {
    await deleteCloudProvider({ path: { type } });
    await get().loadCloudProviders();
    await get().getAvailableCloudProviderModels();
  },

  getAvailableCloudProviderModels: async () => {
    set({ loadingAvailableCloudProviderModels: true });
    try {
      const { data } = await getCloudProviderModels();
      set({ availableCloudProviderModels: data });
    } finally {
      set({ loadingAvailableCloudProviderModels: false });
    }
  },
}));

// Initialize data on store creation
useCloudProvidersStore.getState().loadCloudProviders();
useCloudProvidersStore.getState().getAvailableCloudProviderModels();

// Subscribe to WebSocket events for real-time updates
// Listen for user-authenticated event to refresh models
webSocketService.subscribe('user-authenticated', () => {
  console.log('User authenticated - refreshing cloud provider models');
  // Refresh both cloud providers and models when user authenticates
  useCloudProvidersStore.getState().loadCloudProviders();
  useCloudProvidersStore.getState().getAvailableCloudProviderModels();
});
