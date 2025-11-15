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
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const ErrorResponsesSchema: Record<
  400 | 401 | 403 | 404 | 500,
  typeof ErrorResponseSchema
> = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  500: ErrorResponseSchema,
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
  return constructResponseSchema(
    z.object({
      data: z.array(itemSchema),
      pagination: PaginationMetaSchema,
    }),
  );
};

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export const SortDirectionSchema = z
  .enum(["asc", "desc"])
  .optional()
  .default("desc")
  .describe("Sort direction (default: desc for descending)");

/**
 * Sorting query parameters schema
 * Supports sorting by a single column
 */
export const SortingQuerySchema = z.object({
  /** Column to sort by */
  sortBy: z.string().optional(),
  /** Sort direction (default: desc for descending) */
  sortDirection: SortDirectionSchema,
});

export type SortDirection = z.infer<typeof SortDirectionSchema>;
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
    sortBy: z
      .enum(allowedSortByValues)
      .optional()
      .describe("Column to sort by (restricted to allowed values)"),
    sortDirection: SortDirectionSchema,
  });

export type SortingQueryFor<T extends readonly [string, ...string[]]> = {
  sortBy?: T[number];
  sortDirection?: SortDirection;
};
