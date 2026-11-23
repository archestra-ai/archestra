import { ServerResponse } from "node:http";

/**
 * Next.js puts eight "close" listeners on the response of a request it proxies
 * to the backend (its router, two abort signals, its HTTP proxy and its
 * compression), and error reporting adds its own. Together they pass Node's
 * limit of 10 per emitter, so Node prints a MaxListenersExceededWarning for
 * every proxied request. Each listener goes away with its response: nothing
 * leaks, and the limit only decides when Node warns.
 *
 * Set on the prototype, the limit applies to every response created afterwards.
 */
export function raiseServerResponseListenerLimit(): void {
  ServerResponse.prototype.setMaxListeners(SERVER_RESPONSE_MAX_LISTENERS);
}

const SERVER_RESPONSE_MAX_LISTENERS = 20;
