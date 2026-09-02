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

// ===========================================================================
// Cursor pagination
// ===========================================================================
//
// A second, opt-in mode that sits alongside the offset mode above rather than
// replacing it. Offset pagination stays the default: it is simpler, it lets
// someone jump to a page, and on a table of a few thousand rows the count
// that powers the pager is cheap.
//
// It stops being cheap on the log tables, which only ever grow. There the
// total is a scan of every row on each page load purely to render "Page 1 of
// N", and an offset lets a caller ask for a page so deep the query has to
// group and sort the entire table before discarding almost all of it. A
// cursor removes both at once: no total to compute, and no way to express a
// deep page, because a cursor is opaque and only ever comes from the response
// before it.
//
// An endpoint picks one mode. Most stay on offset.

/**
 * Query parameters for a cursor-paginated endpoint.
 *
 * Deliberately carries no `offset`. An endpoint on this schema cannot be
 * asked for an arbitrary page: zod strips unknown keys, so a hand-written
 * `?page=8500&offset=87000` is dropped and the request serves the newest
 * rows. That guard belongs here rather than in the UI, because the API is
 * reachable without it.
 */
export const CursorQuerySchema = z.object({
  /** Number of items per page (default: 20, max: 100) */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * Opaque position taken from a previous response's `nextCursor`. Omit it
   * for the first (newest) page. Never build one by hand: the encoding is an
   * implementation detail and may change.
   */
  cursor: z.string().optional(),
});

/**
 * Pagination metadata for a cursor-paginated response.
 *
 * No `total` and no `totalPages`, which is the whole point — producing either
 * costs a scan of the table. A null `nextCursor` is how a client learns it
 * has reached the end, and it comes from reading one row more than the page
 * needs rather than from counting anything.
 */
export const CursorPaginationMetaSchema = z.object({
  /** Number of items per page */
  limit: z.number().int().min(1),
  /** Position to pass back for the next page, or null at the end */
  nextCursor: z.string().nullable(),
  /** Whether another page exists */
  hasNext: z.boolean(),
});

export type CursorQuery = z.infer<typeof CursorQuerySchema>;
export type CursorPaginationMeta = z.infer<typeof CursorPaginationMetaSchema>;

/**
 * Generic cursor-paginated response wrapper. Mirrors
 * {@link createPaginatedResponseSchema} so a route swaps one for the other.
 */
export const createCursorPaginatedResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
) =>
  z.object({
    data: z.array(itemSchema),
    pagination: CursorPaginationMetaSchema,
  });
