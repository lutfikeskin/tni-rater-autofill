# The usage-log server only (no extension code, no dev dependencies): Node built-ins, one file.
# Railway builds this (RAILWAY_DOCKERFILE_PATH=server/Dockerfile) and mounts its volume at /data.
FROM node:22-alpine
WORKDIR /app
COPY server/index.mjs server/index.mjs
ENV HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
CMD ["node", "server/index.mjs"]
