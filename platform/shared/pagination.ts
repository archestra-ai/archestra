import { z } from "zod";

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

export type PaginationParams = z.infer<typeof PaginationQuerySchema>;
export type PaginationQuery = PaginationParams;
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

/**
 * Generic paginated response wrapper
 * Use this to wrap any array of items with pagination metadata
 */
export const createPaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
) =>
  z.object({
    data: z.array(itemSchema),
    pagination: PaginationMetaSchema,
  });

export function calculatePaginationMeta(
  total: number,
  params: PaginationParams,
): PaginationMeta {
  const totalPages = Math.ceil(total / params.limit);
  const currentPage = Math.floor(params.offset / params.limit) + 1;

  return {
    currentPage,
    limit: params.limit,
    total,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
  };
}
