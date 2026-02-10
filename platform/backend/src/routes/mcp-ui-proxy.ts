import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const MCP_UI_PROXY_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>MCP-UI Proxy</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100vh;
        width: 100vw;
      }
      body {
        display: flex;
        flex-direction: column;
      }
      * {
        box-sizing: border-box;
      }
      iframe {
        background-color: transparent;
        border: 0px none transparent;
        padding: 0px;
        overflow: hidden;
        flex-grow: 1;
      }
    </style>
  </head>
  <body>
    <script>
      const params = new URLSearchParams(location.search);
      const contentType = params.get('contentType');
      const target = params.get('url');

      // Validate that the URL is a valid HTTP or HTTPS URL
      function isValidHttpUrl(string) {
        try {
          const url = new URL(string);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (error) {
          return false;
        }
      }

      if (contentType === 'rawhtml') {
        // Double-iframe raw HTML mode (HTML sent via postMessage)
        const inner = document.createElement('iframe');

        inner.id = 'root';
        let pendingHtml = null;

        // Helper function to write HTML using document.write
        const renderHtmlInIframe = (markup) => {
          const doc = inner.contentDocument || inner.contentWindow?.document;
          if (!doc) return false;
          try {
            doc.open();
            doc.write(markup);
            doc.close();
            return true;
          } catch (error) {
            console.error('Failed to write HTML to iframe:', error);
            return false;
          }
        };

        // Retry writing pending HTML when iframe finishes loading
        inner.addEventListener('load', () => {
          if (pendingHtml !== null && renderHtmlInIframe(pendingHtml)) {
            pendingHtml = null;
          }
        });

        inner.style = 'width:100%; height:100%; border:none;';
        // Set src to about:blank so browser initializes contentDocument
        inner.src = 'about:blank';
        document.body.appendChild(inner);

        // Wait for HTML content from parent
        window.addEventListener('message', (event) => {
          if (event.source === window.parent && event.data && event.data.type === 'ui-html-content') {
            const payload = event.data.payload || {};
            const html = payload.html;
            if (typeof html === 'string') {
              // Try to write immediately; if contentDocument isn't ready, queue for retry
              if (!renderHtmlInIframe(html)) {
                pendingHtml = html;
              }
            }
          } else if (event.source === window.parent) {
            // Forward other messages from parent to inner iframe
            if (inner && inner.contentWindow) {
              inner.contentWindow.postMessage(event.data, '*');
            }
          } else if (event.source === inner.contentWindow) {
            // Relay messages from inner to parent
            window.parent.postMessage(event.data, '*');
          }
        });

        // Notify parent that proxy is ready to receive HTML (distinct event)
        window.parent.postMessage({ type: 'ui-proxy-iframe-ready' }, '*');
      } else if (target) {
        if (!isValidHttpUrl(target)) {
          document.body.textContent = 'Error: invalid URL. Only HTTP and HTTPS URLs are allowed.';
        } else {
          const inner = document.createElement('iframe');
          inner.src = target;
          inner.style = 'width:100%; height:100%; border:none;';
          // Default external URL sandbox; can be adjusted later by protocol if needed
          inner.setAttribute('sandbox', 'allow-same-origin allow-scripts');
          document.body.appendChild(inner);
          const urlOrigin = new URL(target).origin;

          window.addEventListener('message', (event) => {
            if (event.source === window.parent) {
              // listen for messages from the parent and send them to the iframe
              inner.contentWindow.postMessage(event.data, urlOrigin);
            } else if (event.source === inner.contentWindow) {
              // listen for messages from the iframe and send them to the parent
              window.parent.postMessage(event.data, '*');
            }
          });
        }
      } else {
        document.body.textContent = 'Error: missing url or html parameter';
      }
    </script>
  </body>
</html>`;

const SANDBOX_PROXY_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Sandbox Proxy</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <script>
    // Sandbox proxy implementation for MCP Apps.
    // Receives HTML content from the host and renders it securely.

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      // Handle resource ready notification (HTML content to render)
      if (data.method === 'ui/notifications/sandbox-resource-ready') {
        const { html } = data.params || {};
        if (html) {
          document.open();
          document.write(html);
          document.close();
        }
      }
    });

    // Signal that the sandbox proxy is ready
    window.parent.postMessage({
      method: 'ui/notifications/sandbox-proxy-ready',
      params: {}
    }, '*');
  </script>
</body>
</html>`;

const mcpUiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Legacy HTML proxy used by UIResourceRenderer / HTMLResourceRenderer.
  fastify.get(
    "/mcp-ui-proxy",
    {
      schema: {
        tags: ["mcp-ui"],
        response: {
          200: z.string(),
        },
      },
    },
    async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      reply.header("Cache-Control", "no-store");
      return MCP_UI_PROXY_HTML;
    },
  );

  // Sandbox proxy used by @mcp-ui/client AppRenderer (MCP Apps).
  fastify.get(
    "/sandbox_proxy.html",
    {
      schema: {
        tags: ["mcp-ui"],
        response: {
          200: z.string(),
        },
      },
    },
    async (_request, reply) => {
      reply.type("text/html; charset=utf-8");
      reply.header("Cache-Control", "no-store");
      return SANDBOX_PROXY_HTML;
    },
  );
};

export default mcpUiProxyRoutes;
