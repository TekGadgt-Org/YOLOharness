FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update \
 && apt-get install --no-install-recommends --yes git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 worker
WORKDIR /app
COPY package.json /app/package.json
COPY src /app/src
USER worker
ENTRYPOINT ["node", "/app/src/container-runtime.mjs"]