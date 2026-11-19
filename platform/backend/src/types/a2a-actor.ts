export type A2AOAuthExecution = {
  tokenId: string;
  clientId: string;
  serviceAccountId?: string;
};

export interface A2AActor {
  id: string;
  kind:
    | "user"
    | "team"
    | "organization"
    | "oauthClient"
    | "serviceAccount"
    | "system";
  organizationId: string;
  oauthExecution?: A2AOAuthExecution;
}
