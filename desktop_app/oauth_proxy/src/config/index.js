import dotenv from 'dotenv';

dotenv.config();

export const config = {
  server: {
    port: process.env.PORT || 8080,
    host: '0.0.0.0',
  },
  
  cors: {
    origin: (origin, callback) => {
      // If CORS_ORIGIN is set, use that (comma-separated list)
      if (process.env.CORS_ORIGIN) {
        const allowedOrigins = process.env.CORS_ORIGIN.split(',').map(o => o.trim());
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      } else {
        // Default allowed origins for development and production
        const defaultOrigins = [
          'archestra-ai://oauth-callback', // Desktop app deep link
          'http://localhost:3000', // Development
          'http://localhost:5173', // Vite dev server
        ];
        
        if (!origin || defaultOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      }
    },
    credentials: true,
  },
};

// Validate required configuration
export function validateConfig() {
  const warnings = [];
  
  // Check for common OAuth client secrets
  const providers = ['google', 'slack'];
  for (const provider of providers) {
    const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];
    
    if (!clientId || !clientSecret) {
      warnings.push(`${provider.toUpperCase()} OAuth credentials not configured`);
    }
  }
  
  if (warnings.length > 0) {
    console.warn('Configuration warnings:', warnings.join(', '));
  }
}