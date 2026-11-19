/** Node fetch does not preserve an overridden Host when a URL is pinned to loopback. */
export const GROK_HTTP = String.raw`
function grokFetch(value, options = {}) {
  const target = new URL(value);
  if (target.protocol !== "http:" || !target.hostname.endsWith(".localhost")) return fetch(value, options);
  return new Promise((resolve, reject) => {
    const headers = new Headers(options.headers);
    headers.set("Host", target.host);
    const request = require("node:http").request(target, {
      hostname: "127.0.0.1",
      method: options.method || "GET",
      headers: Object.fromEntries(headers),
      signal: options.signal,
    }, response => {
      if (options.redirect === "error" && response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        reject(new TypeError("Redirects are not accepted for the approved connection."));
        return;
      }
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      const body = [204, 205, 304].includes(response.statusCode) ? null : require("node:stream").Readable.toWeb(response);
      resolve(new Response(body, { status: response.statusCode, headers: responseHeaders }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
}
`;
