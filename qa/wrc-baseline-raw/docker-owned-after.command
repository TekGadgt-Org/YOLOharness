/usr/bin/docker ps -a --no-trunc --filter label=yoloharness.run --format {{.ID}} {{.Names}} {{.Label "yoloharness.run"}}
