export interface JiraConfig {
  jiraBaseUrl: string;
  projectKey?: string;
  jqlQuery?: string;
  isCloud: boolean;
  commentEmailBlacklist?: string[];
  labelsToSkip?: string[];
}

export interface JiraCheckpoint {
  lastSyncedAt?: string;
  lastIssueKey?: string;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    comment?: {
      comments: JiraComment[];
    };
    reporter?: { displayName?: string; emailAddress?: string };
    assignee?: { displayName?: string; emailAddress?: string };
    priority?: { name: string };
    status?: { name: string };
    labels?: string[];
    issuetype?: { name: string };
    updated?: string;
  };
}

export interface JiraComment {
  body: unknown;
  author?: { displayName?: string; emailAddress?: string };
  created?: string;
}

export interface JiraSearchResponse {
  issues: JiraIssue[];
  startAt: number;
  maxResults: number;
  total: number;
}
