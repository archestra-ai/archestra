# OAuth Proxy Server

A secure, minimalistic OAuth proxy server built with Fastify that handles PKCE-based OAuth flows. The proxy adds client secrets server-side, keeping them secure while allowing public clients to complete OAuth flows.

## Architecture

The proxy acts as a secure middleware between OAuth clients (without secrets) and OAuth providers:

```mermaid
sequenceDiagram
    participant User
    participant Client as OAuth Client<br/>(NO SECRET)
    participant Proxy as Proxy Server<br/>(HAS SECRET)
    participant Provider as OAuth Provider

    Note over User,Provider: Authorization (Client-side)
    User->>Client: Start OAuth
    Client->>Client: Generate PKCE<br/>verifier & challenge
    Client->>User: Redirect to Provider
    User->>Provider: Login & Authorize
    Provider->>User: Redirect with code
    User->>Client: Authorization code

    Note over Client,Provider: Token Exchange (Via Proxy)
    Client->>Proxy: POST /oauth/token<br/>grant_type=authorization_code<br/>code + code_verifier
    Proxy->>Proxy: Add client_secret
    Proxy->>Provider: Exchange code<br/>+ client_secret
    Provider-->>Proxy: access_token<br/>refresh_token
    Proxy-->>Client: tokens
    Client-->>User: Success

    Note over Client,Provider: Token Refresh (Via Proxy)
    Client->>Proxy: POST /oauth/token<br/>grant_type=refresh_token<br/>refresh_token
    Proxy->>Proxy: Add client_secret
    Proxy->>Provider: Refresh token<br/>+ client_secret
    Provider-->>Proxy: new access_token
    Proxy-->>Client: new token
```

## Features

- 🔐 **Secure**: Client secrets never exposed to frontend
- 🚀 **Fast**: Built with Fastify for high performance
- 🔌 **Extensible**: Easy to add new OAuth providers
- 🛡️ **PKCE Support**: Full support for PKCE flow
- 📝 **Simple**: Minimal dependencies, clean architecture

## Installation

```bash
# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env

# Edit .env with your OAuth credentials
```

## Configuration

Edit `.env` file with your OAuth credentials:

```env
# Server
PORT=8080
LOG_LEVEL=info

# CORS
CORS_ORIGIN=http://localhost:3000,https://localhost:3000

# Google OAuth
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret

# Slack OAuth
SLACK_CLIENT_ID=your_client_id
SLACK_CLIENT_SECRET=your_client_secret
```

## Running the Server

### Development

```bash
pnpm dev
```

### Production

```bash
pnpm start
```

### With ngrok (https for slack, etc)

1. Install ngrok:

```bash
brew install ngrok/ngrok/ngrok
```

2. Start the server:

```bash
pnpm start
```

3. In another terminal, start ngrok:

```bash
ngrok http 8080
```

4. Use the provided HTTPS URL from ngrok for secure OAuth callbacks.
