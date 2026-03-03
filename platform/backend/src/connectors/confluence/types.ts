export interface ConfluenceConfig {
  confluenceUrl: string;
  spaceKeys?: string[];
  pageIds?: string[];
  cqlQuery?: string;
  isCloud: boolean;
  labelsToSkip?: string[];
  batchSize?: number;
}

export interface ConfluenceCheckpoint {
  lastSyncedAt?: string;
  lastPageId?: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  status: string;
  body?: {
    storage?: {
      value: string;
    };
  };
  metadata?: {
    labels?: {
      results?: Array<{ name: string }>;
    };
  };
  version?: {
    when?: string;
  };
  _links?: {
    webui?: string;
    self?: string;
  };
  space?: {
    key?: string;
    name?: string;
  };
}

export interface ConfluenceSearchResponse {
  results: ConfluencePage[];
  start: number;
  limit: number;
  size: number;
  _links?: {
    next?: string;
  };
}
