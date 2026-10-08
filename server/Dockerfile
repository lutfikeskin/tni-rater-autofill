# The usage-log server only (no extension code, no dev dependencies): Node built-ins, one file.
# Railway builds this (RAILWAY_DOCKERFILE_PATH=server/Dockerfile) and mounts its volume at /data.
# HOST=0.0.0.0 means the server refuses to start unless RATER_TOKEN is set (server/index.mjs,
# startupError): confirm the variable in Railway before deploying (docs/hosting.md).
#
# The process runs as root (the image's default). Running it as the image's `node` user
# (`USER node` before CMD) is the intended hardening, but not until the volume's ownership is
# verified: Railway mounts /data root-owned, and a non-root process that can't write there would
# lose every upload (500 "could not store events") instead of failing safe. Before adding
# `USER node`, check `ls -ld /data` and a test write as `node` in the running container (or add an
# entrypoint that chowns /data first), then redeploy and confirm /v1/events still stores.
FROM node:22-alpine
WORKDIR /app
COPY server/index.mjs server/privacy.html server/
ENV HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
CMD ["node", "server/index.mjs"]
