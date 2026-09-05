#!/bin/sh
set -u
OUT="qa/wrc-baseline-raw"
mkdir -p "$OUT"
run() {
  name="$1"; shift
  start=$(date --iso-8601=seconds)
  printf '%s\n' "$*" > "$OUT/$name.command"
  "$@" >"$OUT/$name.stdout" 2>"$OUT/$name.stderr"
  status=$?
  end=$(date --iso-8601=seconds)
  printf 'started=%s\nended=%s\nexit=%s\n' "$start" "$end" "$status" > "$OUT/$name.status"
}
run npm-test npm test
run real-docker npm run test:docker
run shipped-fixture env -i PATH=/usr/bin:/bin HOME=/tmp/yoloharness-baseline-home XDG_CONFIG_HOME=/tmp/yoloharness-baseline-home/.config XDG_DATA_HOME=/tmp/yoloharness-baseline-home/.local/share node src/cli.mjs --fixture
run shipped-empty env -i PATH=/usr/bin:/bin HOME=/tmp/yoloharness-baseline-home XDG_CONFIG_HOME=/tmp/yoloharness-baseline-home/.config XDG_DATA_HOME=/tmp/yoloharness-baseline-home/.local/share node src/cli.mjs 'synthetic baseline probe'
run docker-info /usr/bin/docker info --format '{{json .}}'
run docker-owned-before /usr/bin/docker ps -a --no-trunc --filter label=yoloharness.run --format '{{.ID}} {{.Names}} {{.Label "yoloharness.run"}}'
run docker-net-before /usr/bin/docker network ls --filter name='^yoloharness-internal-' --format '{{.Name}}'
run docker-images-before /usr/bin/docker image ls --filter reference='yoloharness-test-derivative:*' --format '{{.Repository}}:{{.Tag}} {{.ID}}'
run image-inspect /usr/bin/docker image inspect --format '{{json .}}' yoloharness-local:0.1.0
run docker-owned-after /usr/bin/docker ps -a --no-trunc --filter label=yoloharness.run --format '{{.ID}} {{.Names}} {{.Label "yoloharness.run"}}'
run docker-net-after /usr/bin/docker network ls --filter name='^yoloharness-internal-' --format '{{.Name}}'
run docker-images-after /usr/bin/docker image ls --filter reference='yoloharness-test-derivative:*' --format '{{.Repository}}:{{.Tag}} {{.ID}}'
