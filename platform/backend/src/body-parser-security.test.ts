import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

const sdkRequire = createRequire(
  import.meta.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"),
);
const expressRequire = createRequire(sdkRequire.resolve("express"));
const parserPath = expressRequire.resolve("body-parser");

// An uncaught decoder error must terminate only the child, never the test runner.
// The real HTTP connection also verifies that the parser finishes draining the
// request after the compressed frame ends.
const scenario = `
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const parser = require(process.argv[1]).json();
const encoding = process.argv[2];
const compress = {
  gzip: zlib.gzipSync,
  deflate: zlib.deflateSync,
  br: zlib.brotliCompressSync,
}[encoding];
const source = Buffer.from('{"value":"preserved"}');
const body = Buffer.concat([
  compress(source), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58),
]);
const server = http.createServer((req, res) => {
  parser(req, res, (error) => {
    res.statusCode = error ? error.status || 500 : 200;
    res.end(JSON.stringify(error ? { error: error.message } : req.body));
  });
});
server.listen(0, "127.0.0.1", () => {
  const req = http.request({
    host: "127.0.0.1", port: server.address().port, method: "POST",
    agent: false,
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": encoding,
      "Content-Length": body.length,
    },
  }, (res) => {
    let output = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { output += chunk; });
    res.on("end", () => {
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(output), { value: "preserved" });
      // Give errors from the trailing bytes time to reach the finished decoder.
      setTimeout(() => server.close(() => process.stdout.write("survived")), 200);
    });
  });
  req.on("error", (error) => { throw error; });
  req.end(body);
});
`;

test.each([
  "gzip",
  "deflate",
  "br",
])("SDK HTTP parser survives trailing bytes after a %s body", (encoding) => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=commonjs", "-e", scenario, parserPath, encoding],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("survived");
});
