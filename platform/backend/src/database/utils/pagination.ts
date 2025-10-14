import type { PgSelect } from "drizzle-orm/pg-core";
import type { PaginationMeta, PaginationQuery } from "@/types";

/**
 * Pagination result containing data and metadata
 */
export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

/**
 * Apply pagination to a Drizzle query builder
 *
 * @param queryBuilder - The Drizzle query builder to paginate
 * @param params - Pagination parameters (limit and offset)
 * @returns The query builder with limit and offset applied
 *
 * @example
 * ```typescript
 * const query = db.select().from(table);
 * const paginatedQuery = applyPagination(query, { limit: 20, offset: 0 });
 * const results = await paginatedQuery;
 * ```
 */
export function applyPagination<T extends PgSelect>(
  queryBuilder: T,
  params: PaginationQuery,
): T {
  return queryBuilder.limit(params.limit).offset(params.offset) as T;
}

/**
 * Calculate pagination metadata
 *
 * @param total - Total number of items in the dataset
 * @param params - Pagination parameters (limit and offset)
 * @returns Pagination metadata object
 *
 * @example
 * ```typescript
 * const meta = calculatePaginationMeta(100, { limit: 20, offset: 40 });
 * // Returns: { currentPage: 3, limit: 20, total: 100, totalPages: 5, hasNext: true, hasPrev: true }
 * ```
 */
export function calculatePaginationMeta(
  total: number,
  params: PaginationQuery,
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

/**
 * Create a paginated result from data and total count
 *
 * This is a helper function that combines data with pagination metadata.
 * Use this when you've already fetched the data and total count separately.
 *
 * @param data - The paginated data array
 * @param total - Total number of items in the dataset
 * @param params - Pagination parameters used to fetch the data
 * @returns Object containing data and pagination metadata
 *
 * @example
 * ```typescript
 * // In your model:
 * const [data, [{ count: total }]] = await Promise.all([
 *   db.select().from(table).limit(limit).offset(offset),
 *   db.select({ count: count() }).from(table)
 * ]);
 *
 * return createPaginatedResult(data, Number(total), { limit, offset });
 * ```
 */
export function createPaginatedResult<T>(
  data: T[],
  total: number,
  params: PaginationQuery,
): PaginatedResult<T> {
  return {
    data,
    pagination: calculatePaginationMeta(total, params),
  };
}
