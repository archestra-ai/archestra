/**
 * Spells out the reranker's response shape in the prompt itself.
 *
 * `generateObject` puts the schema in `response_format`, never in the prompt,
 * so a provider client that can't send a JSON schema — or an endpoint that
 * ignores one — leaves the model with no description of the object at all. It
 * then answers in whatever shape it likes and the reply fails validation.
 *
 * Both the reranker and the settings probe that verifies it state this
 * contract, so verifying a model proves the same thing reranking will ask of
 * it. It lives in its own module rather than in `reranker.ts` because callers
 * that only need the wording should not have to import the query-time reranker
 * (which tests routinely stub) to get it.
 */
export const RERANKER_OUTPUT_CONTRACT =
  'Respond with only a JSON object of the form {"scores":[{"index":0,"score":7}]}, ' +
  "with one entry per passage — no prose, no markdown code fences.";
