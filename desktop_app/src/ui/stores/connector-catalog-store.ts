import { create } from 'zustand';

import { localCatalogServers } from '@ui/catalog_local';
import config from '@ui/config';
import {
  type ArchestraMcpServerManifest,
  type SearchMcpServerCatalogData,
  getMcpServerCategories,
  searchMcpServerCatalog,
} from '@ui/lib/clients/archestra/catalog/gen';

/**
 * NOTE: ideally should be divisible by 3 to make it look nice in the UI (as we tend to have 3 "columns" of servers)
 */
const CATALOG_PAGE_SIZE = 24;

interface ConnectorCatalogState {
  connectorCatalog: ArchestraMcpServerManifest[];
  loadingConnectorCatalog: boolean;
  errorFetchingConnectorCatalog: string | null;

  connectorCatalogCategories: string[];
  loadingConnectorCatalogCategories: boolean;
  errorFetchingConnectorCatalogCategories: string | null;

  catalogSearchQuery: string;
  catalogSelectedCategory: string;
  catalogHasMore: boolean;
  catalogTotalCount: number;
  catalogOffset: number;
}

interface ConnectorCatalogActions {
  loadConnectorCatalog: (append?: boolean) => Promise<void>;
  loadConnectorCatalogCategories: () => Promise<void>;
  loadMoreCatalogServers: () => Promise<void>;
  setCatalogSearchQuery: (query: string) => void;
  setCatalogSelectedCategory: (category: string) => void;
  resetCatalogSearch: () => void;

  _init: () => void;
}

type ConnectorCatalogStore = ConnectorCatalogState & ConnectorCatalogActions;

export const useConnectorCatalogStore = create<ConnectorCatalogStore>((set, get) => ({
  // State
  connectorCatalog: [],
  loadingConnectorCatalog: false,
  errorFetchingConnectorCatalog: null,
  catalogSearchQuery: '',
  catalogSelectedCategory: 'all',
  catalogHasMore: true,
  catalogTotalCount: 0,
  catalogOffset: 0,

  connectorCatalogCategories: [],
  loadingConnectorCatalogCategories: false,
  errorFetchingConnectorCatalogCategories: null,

  // Actions
  loadConnectorCatalog: async (append = false) => {
    const { catalogSearchQuery, catalogSelectedCategory, catalogOffset } = get();

    try {
      set({
        loadingConnectorCatalog: true,
        errorFetchingConnectorCatalog: null,
      });

      const params: SearchMcpServerCatalogData['query'] = {
        limit: CATALOG_PAGE_SIZE,
        offset: append ? catalogOffset : 0,
        worksInArchestra: true,
      };

      if (catalogSearchQuery) {
        params.q = catalogSearchQuery;
      }

      if (catalogSelectedCategory && catalogSelectedCategory !== 'all') {
        params.category = catalogSelectedCategory as NonNullable<SearchMcpServerCatalogData['query']>['category'];
      }

      const { data } = await searchMcpServerCatalog({ query: params });

      if (data) {
        let filteredLocalServers: ArchestraMcpServerManifest[] = [];

        // Only include local catalog servers in development mode
        if (config.isDev) {
          filteredLocalServers = localCatalogServers;

          if (catalogSearchQuery) {
            const query = catalogSearchQuery.toLowerCase();
            filteredLocalServers = filteredLocalServers.filter(
              (server) =>
                server.name.toLowerCase().includes(query) ||
                server.display_name.toLowerCase().includes(query) ||
                server.description.toLowerCase().includes(query)
            );
          }

          if (catalogSelectedCategory && catalogSelectedCategory !== 'all') {
            filteredLocalServers = filteredLocalServers.filter((server) => server.category === catalogSelectedCategory);
          }
        }

        // Merge local and remote servers
        // Local servers appear first when not appending (initial load or filter change)
        const remoteServers = data.servers || [];
        const mergedServers = append
          ? [...get().connectorCatalog, ...remoteServers]
          : [...filteredLocalServers, ...remoteServers];

        set({
          connectorCatalog: mergedServers,
          catalogHasMore: data.hasMore || false,
          catalogTotalCount: (data.totalCount || 0) + filteredLocalServers.length,
          catalogOffset: append ? get().catalogOffset + CATALOG_PAGE_SIZE : CATALOG_PAGE_SIZE,
        });
      }
    } catch (error) {
      set({ errorFetchingConnectorCatalog: error as string });
    } finally {
      set({ loadingConnectorCatalog: false });
    }
  },

  loadConnectorCatalogCategories: async () => {
    try {
      set({ loadingConnectorCatalogCategories: true, errorFetchingConnectorCatalogCategories: null });
      const { data } = await getMcpServerCategories();
      set({ connectorCatalogCategories: data?.categories || [] });
    } catch (error) {
      set({ errorFetchingConnectorCatalogCategories: error as string });
    } finally {
      set({ loadingConnectorCatalogCategories: false });
    }
  },

  loadMoreCatalogServers: async () => {
    const { catalogHasMore, loadingConnectorCatalog } = get();
    if (!catalogHasMore || loadingConnectorCatalog) return;

    await get().loadConnectorCatalog(true);
  },

  setCatalogSearchQuery: (query: string) => {
    set({
      catalogSearchQuery: query,
      catalogOffset: 0,
    });
    get().loadConnectorCatalog();
  },

  setCatalogSelectedCategory: (category: string) => {
    set({
      catalogSelectedCategory: category,
      catalogOffset: 0,
    });
    get().loadConnectorCatalog();
  },

  resetCatalogSearch: () => {
    set({
      catalogSearchQuery: '',
      catalogSelectedCategory: 'all',
      catalogOffset: 0,
      catalogHasMore: true,
    });
    get().loadConnectorCatalog();
  },

  _init: () => {
    const { loadConnectorCatalog, loadConnectorCatalogCategories } = get();

    loadConnectorCatalog();
    loadConnectorCatalogCategories();
  },
}));

/**
 * Initialize data on store creation
 */
useConnectorCatalogStore.getState()._init();
