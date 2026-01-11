#!/usr/bin/env bash
set -euo pipefail

IMAGE="${ACT_IMAGE:-vscode-insiders-act:node20}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building act runner image: $IMAGE" >&2
  docker build -t "$IMAGE" -f act/Dockerfile act >/dev/null
fi

exec act --pull=false "$@"
