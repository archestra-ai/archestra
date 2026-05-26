import { ApiError, ApiErrorTypeSchema } from "@shared";
import { z } from "zod";
import {
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  UnauthenticatedError,
  UnauthorizedError,
  UnknownError,
  ValidationError,
} from "@/errors";

export { ApiError, ApiErrorTypeSchema };

export type ApiErrorType = z.infer<typeof ApiErrorTypeSchema>;

export type ServiceErrorHttpMapping = {
  statusCode: number;
  type: ApiErrorType;
};

/**
 * Translate a domain error from `@/errors` into the HTTP status + response
 * `type` literal expected by `constructResponseSchema`. Returns `null` if
 * the error isn't a known domain error — the global handler then falls
 * through to its other branches (`ApiError`, generic 500, etc.).
 *
 * Lives here (not in `@/errors`) because the domain layer is HTTP-unaware.
 */
export function mapServiceErrorToHttp(
  error: unknown,
): ServiceErrorHttpMapping | null {
  if (error instanceof ValidationError)
    return { statusCode: 400, type: "api_validation_error" };
  if (error instanceof UnauthenticatedError)
    return { statusCode: 401, type: "api_authentication_error" };
  if (error instanceof UnauthorizedError)
    return { statusCode: 403, type: "api_authorization_error" };
  if (error instanceof NotFoundError)
    return { statusCode: 404, type: "api_not_found_error" };
  if (error instanceof PreconditionFailedError)
    return { statusCode: 409, type: "api_conflict_error" };
  if (error instanceof InternalError)
    return { statusCode: 500, type: "api_internal_server_error" };
  if (error instanceof UnknownError)
    return { statusCode: 500, type: "api_internal_server_error" };
  return null;
}

export const UuidIdSchema = z.uuidv4();

export const UuidOrSlugSchema = z.string().min(1);

export type ErrorResponseSchema<T extends z.infer<typeof ApiErrorTypeSchema>> =
  {
    error: {
      message: string;
      type: T;
      internal_code?: string;
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
      internal_code: z.string().optional(),
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

export const SortDirectionSchema = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof SortDirectionSchema>;

/**
 * Sorting query parameters schema
 * Supports sorting by a single column
 */
export const SortingQuerySchema = z.object({
  /** Column to sort by */
  sortBy: z.string().optional(),
  /** Sort direction (default: desc for descending) */
  sortDirection: SortDirectionSchema.optional().default("desc"),
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
    sortDirection: SortDirectionSchema.optional().default("desc"),
  });

export type SortingQueryFor<T extends readonly [string, ...string[]]> = {
  sortBy?: T[number];
  sortDirection?: SortDirection;
};

export const DeleteObjectResponseSchema = z.object({ success: z.boolean() });
