export default async function callbackRoutes(fastify) {
  // Helper function to handle OAuth callback
  const handleCallback = async (request, reply, provider) => {
    const { code, state, error, error_description } = request.query;

    // Build parameters for deeplink
    const params = new URLSearchParams();
    if (code) params.append("code", code);
    if (state) params.append("state", state);
    if (error) params.append("error", error);
    if (error_description)
      params.append("error_description", error_description);
    params.append("service", provider);

    // Create deeplink to the desktop app
    const deeplinkUrl = `archestra-ai://oauth-callback?${params.toString()}`;

    // Return HTML that opens the deeplink
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>OAuth Callback</title>
        <meta charset="utf-8">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            text-align: center;
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          h1 { color: #333; }
          p { color: #666; margin: 20px 0; }
          a {
            display: inline-block;
            padding: 12px 24px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            margin-top: 20px;
          }
          a:hover { background: #5a67d8; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Authentication Successful</h1>
          <p>Redirecting to Archestra...</p>
          <p>If the app doesn't open automatically, <a id="deeplink">click here</a></p>
        </div>
        <script>
          // Safely encode the deeplink URL
          const deeplinkUrl = ${JSON.stringify(deeplinkUrl)};
          
          // Set the href attribute safely
          document.getElementById('deeplink').href = deeplinkUrl;
          
          // Try to open the deeplink
          window.location.href = deeplinkUrl;
        </script>
      </body>
      </html>
    `;

    fastify.log.info(
      `OAuth callback for ${provider}, opening deeplink: ${deeplinkUrl}`,
    );

    return reply.type('text/html').send(html);
  };

  // OAuth callback endpoint - redirects back to the desktop app
  fastify.get("/callback/:provider", async (request, reply) => {
    const { provider } = request.params;
    return handleCallback(request, reply, provider);
  });

  // Alternative OAuth callback endpoint (for Slack which uses /oauth-callback)
  fastify.get("/oauth-callback", async (request, reply) => {
    // Determine provider from query params (Slack includes service param)
    const provider = request.query.service || 'slack';
    return handleCallback(request, reply, provider);
  });

  // Generic OAuth callback endpoint (for providers using /oauth/callback)
  fastify.get("/oauth/callback", async (request, reply) => {
    // Default to google since this is the most common OAuth callback pattern
    const provider = 'google';
    return handleCallback(request, reply, provider);
  });
}
