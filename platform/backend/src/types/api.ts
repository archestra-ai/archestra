import { ApiError, ApiErrorTypeSchema } from "@shared/types";
import { z } from "zod";

export { ApiError, ApiErrorTypeSchema };

export const UuidIdSchema = z.uuidv4();

export type ErrorResponseSchema<T extends z.infer<typeof ApiErrorTypeSchema>> =
  {
    error: {
      message: string;
      type: T;
    };
  };

export const generateErrorResponseSchema = <
  T extends z.infer<typeof ApiErrorTypeSchema>,
>(
  errorType: T,
) =>
  z.object({
    error: z.object({
      message: z.string(),
      type: z.literal(errorType),
    }),
  });

export const ErrorResponsesSchema = {
  400: generateErrorResponseSchema("api_validation_error"),
  401: generateErrorResponseSchema("api_authentication_error"),
  403: generateErrorResponseSchema("api_authorization_error"),
  404: generateErrorResponseSchema("api_not_found_error"),
  409: generateErrorResponseSchema("api_conflict_error"),
  500: generateErrorResponseSchema("api_internal_server_error"),
};

export const constructResponseSchema = <T extends z.ZodTypeAny>(
  schema: T,
): typeof ErrorResponsesSchema & {
  200: T;
} => ({
  200: schema,
  ...ErrorResponsesSchema,
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

export const DeleteObjectResponseSchema = z.object({ success: z.boolean() });
