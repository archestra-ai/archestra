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
 * Supports both offset-based and cursor-based pagination
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
