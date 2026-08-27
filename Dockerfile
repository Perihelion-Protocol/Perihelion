# Multi-stage build for Perihelion relayer and solver containers.
# Usage:
#   docker build --build-arg PACKAGE=relayer -t perihelion-relayer .
#   docker build --build-arg PACKAGE=solver -t perihelion-solver .

FROM node:20-alpine@sha256:d0f0f9e87e9451c2ae12a69b88c65b8eba13c7fa876beb0c4f1c45301aebcc5f AS build

WORKDIR /app

# Copy root and workspace package files for dependency resolution
COPY package*.json ./
COPY sdk/package.json sdk/
COPY relayer/package.json relayer/
COPY solver/package.json solver/
COPY mempool/package.json mempool/
COPY test/package.json test/

# Install dependencies with workspace symlink resolution
RUN npm ci

# Copy entire repository and build
COPY . .
RUN npm run build

# Runtime stage — minimal image with only production artifacts
FROM node:20-alpine@sha256:d0f0f9e87e9451c2ae12a69b88c65b8eba13c7fa876beb0c4f1c45301aebcc5f

ARG PACKAGE=relayer
WORKDIR /app

# Copy built artifacts and node_modules from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/${PACKAGE}/dist ./${PACKAGE}/dist
COPY --from=build /app/sdk/dist ./sdk/dist
COPY --from=build /app/sdk/package.json ./sdk/
COPY --from=build /app/${PACKAGE}/package.json ./${PACKAGE}/

# Promote build-time ARG to runtime environment variable for CMD expansion
ENV PACKAGE=${PACKAGE}

# Run as the non-root node user provided by the base image
USER node

# Health check for Docker container orchestration
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/healthz', (r) => { if (r.statusCode === 200) process.exit(0); process.exit(1); })" || exit 1

# Start the relayer or solver with shell expansion and exec to maintain PID 1
CMD ["sh", "-c", "exec node \"$PACKAGE/dist/index.js\""]
