# The Archestra cluster agent. Node runs the TypeScript sources directly; the
# agent has no dependencies beyond Node itself.
FROM node:24-alpine
WORKDIR /app
RUN echo '{"private":true,"type":"module"}' > package.json
COPY src ./src
USER 1000:1000
CMD ["node", "src/main.ts"]
