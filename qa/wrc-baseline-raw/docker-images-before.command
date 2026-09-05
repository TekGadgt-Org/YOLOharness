/usr/bin/docker image ls --filter reference=yoloharness-test-derivative:* --format {{.Repository}}:{{.Tag}} {{.ID}}
