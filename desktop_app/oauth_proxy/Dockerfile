# Use official Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port (default 3000)
ENV PORT=3000
EXPOSE $PORT

# Start the server
CMD ["node", "src/server.js"]
