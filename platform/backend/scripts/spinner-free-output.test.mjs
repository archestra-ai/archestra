import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { forwardWithoutSpinner } from "./spinner-free-output.mjs";

const REDRAW = "\x1b[2K\x1b[1G";

test("writes only the last frame of a redrawn line", async () => {
  const output = await forward([
    "Using 'pg' driver for database querying\n[⣷] applying migrations...",
    `${REDRAW}[⣯] applying migrations...${REDRAW}[⣟] applying`,
    ` migrations...${REDRAW}[✓] migrations applied successfully!`,
  ]);

  assert.equal(
    output,
    "Using 'pg' driver for database querying\n[✓] migrations applied successfully!\n",
  );
});

test("passes output that is never redrawn through unchanged", async () => {
  const output = await forward(["error: relation ", '"x" exists\nhint\n']);

  assert.equal(output, 'error: relation "x" exists\nhint\n');
});

async function forward(chunks) {
  const source = new PassThrough();
  const target = new PassThrough();
  target.setEncoding("utf8");
  let output = "";
  target.on("data", (chunk) => {
    output += chunk;
  });
  forwardWithoutSpinner(source, target);
  for (const chunk of chunks) source.write(chunk);
  source.end();
  await new Promise((resolve) => source.once("end", resolve));
  return output;
}
