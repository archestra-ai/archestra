// Qualify the npm HTTP client independently of the Node built-in fetch client.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const net = require("node:net");
const { Client, fetch } = require("/usr/local/lib/node_modules/npm/node_modules/undici");

(async () => {
  const server = net.createServer((socket) => {
    socket.once("data", (request) => {
      if (request.toString().startsWith("GET /healthy ")) {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      } else {
        socket.end("HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client(url);
  try {
    assert.equal(await (await fetch(`${url}/healthy`, { dispatcher: client })).text(), "ok");
    await assert.rejects(fetch(`${url}/excessive`, { dispatcher: client }),
      (error) => error.cause?.message.includes("content-encoding"));
    // Vulnerable copies reject fetch but then crash on a later stream error.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await (await fetch(`${url}/healthy`, { dispatcher: client })).text(), "ok");
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
