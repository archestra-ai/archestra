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
            position: relative;
            overflow: hidden;
          }
          
          @keyframes drift {
            0% { 
              transform: translateX(-100px);
              opacity: 0;
            }
            10% {
              opacity: 1;
            }
            90% {
              opacity: 1;
            }
            100% { 
              transform: translateX(calc(100vw + 100px));
              opacity: 0;
            }
          }
          
          @keyframes driftSlow {
            0% { 
              transform: translateX(-100px) translateY(0);
              opacity: 0;
            }
            10% {
              opacity: 0.8;
            }
            50% {
              transform: translateX(50vw) translateY(-30px);
            }
            90% {
              opacity: 0.8;
            }
            100% { 
              transform: translateX(calc(100vw + 100px)) translateY(0);
              opacity: 0;
            }
          }
          
          .particle {
            position: absolute;
            width: 8px;
            height: 8px;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 50%;
            animation: drift 8s linear infinite;
            box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
          }
          
          .particle:nth-child(even) {
            width: 6px;
            height: 6px;
            animation: driftSlow 12s linear infinite;
            background: rgba(255, 255, 255, 0.7);
          }
          
          .particle:nth-child(3n) {
            width: 10px;
            height: 10px;
            animation-duration: 6s;
            background: rgba(255, 255, 255, 1);
            box-shadow: 0 0 15px rgba(255, 255, 255, 0.8);
          }
          
          .shape {
            position: absolute;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            animation: drift 15s linear infinite;
            background: rgba(255, 255, 255, 0.05);
          }
          
          .shape.square {
            border-radius: 20%;
            animation-duration: 18s;
          }
          .container {
            text-align: center;
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            max-width: 500px;
            position: relative;
            z-index: 10;
          }
          h1 { color: #333; }
          p { color: #666; margin: 20px 0; }
          .privacy-text {
            background: #f7f9fc;
            border-left: 4px solid #667eea;
            padding: 15px 20px;
            margin: 25px 0;
            text-align: left;
            font-size: 14px;
            line-height: 1.6;
            color: #4a5568;
            border-radius: 4px;
          }
          .privacy-text strong {
            color: #2d3748;
          }
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
        <div id="particles"></div>
        <div class="container">
          <h1>Authentication Successful</h1>
          <p>Redirecting to Archestra...</p>
          <div class="privacy-text">
            <strong>A quick note</strong><br>
            Unlike other apps, <b>we don't store your OAuth secrets</b> so we can't access your data from our cloud. </br><br>
            Once you're redirected to the desktop app, your keys will be stored locally <b>on your device only</b>, and all subsequent interactions with your data will occur directly between the third-party service and your local Archestra app.
          </div>
          <p>If the app doesn't open automatically, <a id="deeplink">click here</a></p>
        </div>
        <script>  
          // Generate animated particles
          const particlesContainer = document.getElementById('particles');
          const numParticles = 50;
          const numShapes = 8;
          
          // Create particles
          for (let i = 0; i < numParticles; i++) {
            const particle = document.createElement('div');
            particle.className = 'particle';
            particle.style.left = '-100px';
            particle.style.top = Math.random() * 100 + '%';
            particle.style.animationDelay = Math.random() * 8 + 's';
            particle.style.animationDuration = (8 + Math.random() * 6) + 's';
            particlesContainer.appendChild(particle);
          }
          
          // Create shapes
          for (let i = 0; i < numShapes; i++) {
            const shape = document.createElement('div');
            shape.className = 'shape' + (i % 2 === 0 ? ' square' : '');
            const size = 30 + Math.random() * 50;
            shape.style.width = size + 'px';
            shape.style.height = size + 'px';
            shape.style.left = '-100px';
            shape.style.top = Math.random() * 100 + '%';
            shape.style.animationDelay = Math.random() * 15 + 's';
            shape.style.animationDuration = (15 + Math.random() * 10) + 's';
            particlesContainer.appendChild(shape);
          }
          
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
