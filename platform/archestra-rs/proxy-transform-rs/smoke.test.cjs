"use strict";

const assert = require("node:assert/strict");
const proxyTransform = require("./index.cjs");

// toonEncodeToolResults: a tiny batch resolves off-thread, positionally, with
// TOON output for JSON content, unwrapping applied when requested, and
// `encoded: null` for non-JSON. Heavy correctness lives in the
// proxy_transform_core cargo tests (goldens + property tests).
const inner = JSON.stringify({ data: [{ id: 1, v: "a" }, { id: 2, v: "b" }], ok: true });
const items = [
  { id: "plain", rawContent: '{"a":1}', unwrap: false },
  {
    id: "wrapped",
    rawContent: JSON.stringify([{ type: "text", text: inner }]),
    unwrap: true,
  },
  { id: "malformed", rawContent: "not json at all", unwrap: true },
];

(async () => {
  const results = await proxyTransform.toonEncodeToolResults(items);
  assert.equal(results.length, items.length);

  // No before-source: token counts are unset.
  assert.deepEqual(results[0], {
    normalized: '{"a":1}',
    encoded: "a: 1",
    beforeTokens: null,
    encodedTokens: null,
  });

  assert.equal(results[1].normalized, inner);
  assert.equal(results[1].encoded, "data[2]{id,v}:\n  1,a\n  2,b\nok: true");

  assert.deepEqual(results[2], {
    normalized: "not json at all",
    encoded: null,
    beforeTokens: null,
    encodedTokens: null,
  });

  // With a before-source, encodable items carry cl100k counts; unencodable
  // ones stay null.
  const counted = await proxyTransform.toonEncodeToolResults(items, "Normalized");
  assert.ok(Number.isInteger(counted[0].beforeTokens) && counted[0].beforeTokens > 0);
  assert.ok(Number.isInteger(counted[0].encodedTokens) && counted[0].encodedTokens > 0);
  assert.equal(counted[2].beforeTokens, null);
  assert.equal(counted[2].encodedTokens, null);

  // Empty batch resolves to an empty array.
  assert.deepEqual(await proxyTransform.toonEncodeToolResults([]), []);

  console.log("proxy-transform-rs smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
