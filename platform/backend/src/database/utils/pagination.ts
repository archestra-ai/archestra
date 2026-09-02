import {
  type CursorPaginationMeta,
  type CursorQuery,
  calculatePaginationMeta,
  type PaginationMeta,
  type PaginationQuery,
} from "@archestra/shared";

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

// ===========================================================================
// Cursor pagination
// ===========================================================================

/**
 * Where a page ended, as the values a keyset predicate compares against.
 *
 * Two parts, because one is not enough: `value` is whatever the query sorts
 * by and is rarely unique (many interactions share a millisecond), so `id`
 * breaks the tie. Without it a row on a shared timestamp is either served
 * twice or skipped at the page boundary.
 */
interface CursorPosition {
  /** The sort column's value, as text. Dates are ISO 8601. */
  value: string;
  /** Primary key of the last row on the page. */
  id: string;
}

export interface CursorPaginatedResult<T> {
  data: T[];
  pagination: CursorPaginationMeta;
}

/**
 * Encode a position as an opaque cursor.
 *
 * base64url rather than plain JSON so it survives a query string untouched,
 * and so it reads as a token a caller should pass back rather than a
 * structure worth editing. It is *not* a security boundary: anyone can decode
 * it. It does not need to be one, because every value inside it also appears
 * in the response the caller just read.
 */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/**
 * Decode a cursor, returning null for anything unusable.
 *
 * Null rather than a throw: a cursor arrives from a URL, so a truncated,
 * stale or hand-edited one is an ordinary event, not an exception. Callers
 * treat null as "start from the newest row", which is the same thing an
 * absent cursor means. A bad cursor therefore costs the reader their place,
 * never an error page.
 */
export function decodeCursor(
  cursor: string | undefined,
): CursorPosition | null {
  if (!cursor) return null;

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "value" in parsed &&
      "id" in parsed &&
      typeof (parsed as CursorPosition).value === "string" &&
      typeof (parsed as CursorPosition).id === "string"
    ) {
      return parsed as CursorPosition;
    }
  } catch {
    // Fall through: unparseable is handled the same as absent.
  }

  return null;
}

/**
 * Build a cursor-paginated result from a page fetched with `limit + 1` rows.
 *
 * The extra row is how "is there more" is answered without counting: if it
 * came back, another page exists. It is dropped before the data is returned,
 * so callers must fetch `limit + 1` and pass the whole thing here.
 *
 * @param rows - Up to `params.limit + 1` rows, in page order
 * @param params - The cursor query the rows were fetched for
 * @param toPosition - Reads the cursor position off a row
 */
export function createCursorPaginatedResult<T>(
  rows: T[],
  params: CursorQuery,
  toPosition: (row: T) => CursorPosition,
): CursorPaginatedResult<T> {
  const hasNext = rows.length > params.limit;
  const data = hasNext ? rows.slice(0, params.limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    pagination: {
      limit: params.limit,
      hasNext,
      // A cursor past the end would invite a request that can only come back
      // empty, so the end of the data is also the end of the cursors.
      nextCursor: hasNext && last ? encodeCursor(toPosition(last)) : null,
    },
  };
}
