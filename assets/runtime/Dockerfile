FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG YOLO_SOURCE_DIGEST
LABEL org.yoloharness.source-digest="${YOLO_SOURCE_DIGEST}"
RUN apt-get update \
 && apt-get install --no-install-recommends --yes git python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 worker
WORKDIR /app
COPY package.json /app/package.json
COPY src /app/src
ENTRYPOINT ["node", "/app/src/container-runtime.mjs"]