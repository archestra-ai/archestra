"use strict";

const assert = require("node:assert/strict");
const imageRs = require("./index.cjs");

// shrinkImageToFit: a small valid PNG resolves off-thread to a ShrunkImage with
// a Buffer `bytes` under the budget and a content type (or null if it can't be
// made to fit). Heavy correctness lives in the image_core cargo tests.
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAADtGLyqAAAAFElEQVQIHWP4z8DAAMIM////ZwAAHu8E/CH5t8cAAAAASUVORK5CYII=",
  "base64",
);

(async () => {
  const maxBytes = 5_000_000;
  const shrunk = await imageRs.shrinkImageToFit(tinyPng, maxBytes, 1024);
  if (shrunk !== null) {
    assert.ok(Buffer.isBuffer(shrunk.bytes));
    assert.ok(shrunk.bytes.length <= maxBytes);
    assert.equal(typeof shrunk.contentType, "string");
  }

  // Garbage bytes resolve to null, not a throw.
  assert.equal(
    await imageRs.shrinkImageToFit(Buffer.from("not an image"), 1000, 100),
    null,
  );

  console.log("image-rs smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
