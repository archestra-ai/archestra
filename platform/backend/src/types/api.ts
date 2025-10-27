import { z } from "zod";

export const UuidIdSchema = z.uuidv4();

export const ErrorResponseSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string(),
      type: z.string(),
    }),
  ]),
});

/**
 * Pagination query parameters schema
 * Supports offset-based pagination
 */
export const PaginationQuerySchema = z.object({
  /** Number of items per page (default: 20, max: 100) */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Page offset for offset-based pagination (0-indexed) */
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Pagination metadata included in paginated responses
 */
export const PaginationMetaSchema = z.object({
  /** Current page number (1-indexed for user-facing API) */
  currentPage: z.number().int().min(1),
  /** Number of items per page */
  limit: z.number().int().min(1),
  /** Total number of items available */
  total: z.number().int().min(0),
  /** Total number of pages */
  totalPages: z.number().int().min(0),
  /** Whether there is a next page */
  hasNext: z.boolean(),
  /** Whether there is a previous page */
  hasPrev: z.boolean(),
});

/**
 * Generic paginated response wrapper
 * Use this to wrap any array of items with pagination metadata
 */
export const createPaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
) => {
  return z.object({
    data: z.array(itemSchema),
    pagination: PaginationMetaSchema,
  });
};

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

/**
 * Sorting query parameters schema
 * Supports sorting by a single column
 */
export const SortingQuerySchema = z.object({
  /** Column to sort by */
  sortBy: z.string().optional(),
  /** Sort direction (default: desc for descending) */
  sortDirection: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type SortingQuery = z.infer<typeof SortingQuerySchema>;

/**
 * Factory for a sorting query schema constrained to specific columns
 * Pass a readonly tuple of allowed column names (non-empty)
 */
export const createSortingQuerySchema = <
  T extends readonly [string, ...string[]],
>(
  allowedSortByValues: T,
) =>
  z.object({
    /** Column to sort by (restricted to allowed values) */
    sortBy: z.enum(allowedSortByValues).optional(),
    /** Sort direction (default: desc for descending) */
    sortDirection: z.enum(["asc", "desc"]).optional().default("desc"),
  });

export type SortingQueryFor<T extends readonly [string, ...string[]]> = {
  sortBy?: T[number];
  sortDirection?: "asc" | "desc";
};

export const RouteId = {
  // Agent Routes
  GetAgents: "getAgents",
  CreateAgent: "createAgent",
  GetAgent: "getAgent",
  GetDefaultAgent: "getDefaultAgent",
  UpdateAgent: "updateAgent",
  DeleteAgent: "deleteAgent",

  // Agent Tool Routes
  AssignToolToAgent: "assignToolToAgent",
  UnassignToolFromAgent: "unassignToolFromAgent",
  GetAgentTools: "getAgentTools",
  GetAllAgentTools: "getAllAgentTools",
  UpdateAgentTool: "updateAgentTool",

  // Features Routes
  GetFeatures: "getFeatures",

  // Auth Routes
  GetDefaultCredentialsStatus: "getDefaultCredentialsStatus",

  // MCP Catalog Routes
  GetInternalMcpCatalog: "getInternalMcpCatalog",
  CreateInternalMcpCatalogItem: "createInternalMcpCatalogItem",
  GetInternalMcpCatalogItem: "getInternalMcpCatalogItem",
  UpdateInternalMcpCatalogItem: "updateInternalMcpCatalogItem",
  DeleteInternalMcpCatalogItem: "deleteInternalMcpCatalogItem",

  // MCP Server Routes
  GetMcpServers: "getMcpServers",
  GetMcpServer: "getMcpServer",
  GetMcpServerTools: "getMcpServerTools",
  InstallMcpServer: "installMcpServer",
  DeleteMcpServer: "deleteMcpServer",

  // OAuth Routes
  InitiateOAuth: "initiateOAuth",
  HandleOAuthCallback: "handleOAuthCallback",

  // Team Routes
  GetTeams: "getTeams",
  CreateTeam: "createTeam",
  GetTeam: "getTeam",
  UpdateTeam: "updateTeam",
  DeleteTeam: "deleteTeam",
  GetTeamMembers: "getTeamMembers",
  AddTeamMember: "addTeamMember",
  RemoveTeamMember: "removeTeamMember",

  // Tool Routes
  GetTools: "getTools",
  GetUnassignedTools: "getUnassignedTools",

  // Interaction Routes
  GetInteractions: "getInteractions",
  GetInteraction: "getInteraction",

  // Autonomy Policy Routes
  GetOperators: "getOperators",
  GetToolInvocationPolicies: "getToolInvocationPolicies",
  CreateToolInvocationPolicy: "createToolInvocationPolicy",
  GetToolInvocationPolicy: "getToolInvocationPolicy",
  UpdateToolInvocationPolicy: "updateToolInvocationPolicy",
  DeleteToolInvocationPolicy: "deleteToolInvocationPolicy",
  GetTrustedDataPolicies: "getTrustedDataPolicies",
  CreateTrustedDataPolicy: "createTrustedDataPolicy",
  GetTrustedDataPolicy: "getTrustedDataPolicy",
  UpdateTrustedDataPolicy: "updateTrustedDataPolicy",
  DeleteTrustedDataPolicy: "deleteTrustedDataPolicy",

  // Dual LLM Config Routes
  GetDefaultDualLlmConfig: "getDefaultDualLlmConfig",
  GetDualLlmConfigs: "getDualLlmConfigs",
  CreateDualLlmConfig: "createDualLlmConfig",
  GetDualLlmConfig: "getDualLlmConfig",
  UpdateDualLlmConfig: "updateDualLlmConfig",
  DeleteDualLlmConfig: "deleteDualLlmConfig",

  // Dual LLM Result Routes
  GetDualLlmResultByToolCallId: "getDualLlmResultByToolCallId",
  GetDualLlmResultsByInteraction: "getDualLlmResultsByInteraction",

  // Proxy Routes - OpenAI
  OpenAiChatCompletionsWithDefaultAgent:
    "openAiChatCompletionsWithDefaultAgent",
  OpenAiChatCompletionsWithAgent: "openAiChatCompletionsWithAgent",

  // Proxy Routes - Anthropic
  AnthropicMessagesWithDefaultAgent: "anthropicMessagesWithDefaultAgent",
  AnthropicMessagesWithAgent: "anthropicMessagesWithAgent",
} as const;
export type RouteId = (typeof RouteId)[keyof typeof RouteId];
