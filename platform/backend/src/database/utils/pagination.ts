import {
  calculatePaginationMeta,
  type PaginationMeta,
  type PaginationQuery,
} from "@shared";

/**
 * Pagination result containing data and metadata
 */
export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
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
