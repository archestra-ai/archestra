/**
 * Media a log row keeps so the Logs page can show or play it: an image a user
 * uploaded to edit, audio a model spoke or was sent. Each file is kept up to
 * this size; a larger one is noted as omitted, never cut short. The Logs copy
 * names the same limit ("2 MB per clip", "2 MB per image").
 */
export const LOGGED_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
