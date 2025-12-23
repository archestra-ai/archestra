FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Initialize project and install dependencies
RUN npm init -y && \
    npm install @modelcontextprotocol/sdk @modelcontextprotocol/server-playwright

# Playwright browsers are already installed in this base image.
# We run as the 'pwuser' created by the base image or create one if needed, 
# but Playwright image usually runs as root by default?
# Better to be explicit about user if we want security.
# However, for simplicity and ensuring browser access, we'll stick to default for now 
# or use 'pwuser' if it exists. The base image docs say: 
# "This image includes Node.js and the Playwright browsers."

# Expose nothing (stdio)

CMD ["npx", "-y", "@modelcontextprotocol/server-playwright"]
