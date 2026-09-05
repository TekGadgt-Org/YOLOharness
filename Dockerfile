FROM node:22-bookworm-slim
RUN useradd --create-home --uid 10001 worker
WORKDIR /app
COPY worker.mjs /app/worker.mjs
USER worker
ENTRYPOINT ["node", "/app/worker.mjs"]
