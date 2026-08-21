/**
 * The most ids one bulk request may carry.
 *
 * It is a cap on the request, not on what a user may select: the UI offers
 * "select all N matching", and N is whatever the filters match. The number is
 * therefore chosen so that the largest batch a person can assemble by hand
 * still fits, while a runaway or hostile caller cannot hand the server an
 * unbounded id list to authorize row by row.
 *
 * Shared because both sides need the same number: routes reject a longer body
 * with 400, and the bulk actions bar stops offering the escalation past it
 * rather than letting someone select 900 rows and then fail.
 */
export const MAX_BULK_IDS = 500;
