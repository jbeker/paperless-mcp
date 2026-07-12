#!/usr/bin/env bash
# Builds the upload proxy image and pushes it to registry.confusticate.com.
# Publishes only committed-and-pushed code so every image is traceable to a
# commit that exists on the remote.
set -euo pipefail

REGISTRY="registry.confusticate.com"
IMAGE="${REGISTRY}/paperless-upload-proxy"
PLATFORM="linux/amd64"

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree has uncommitted or untracked changes; commit and push first" >&2
  exit 1
fi

git fetch --quiet
if ! upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
  echo "error: current branch has no upstream; push it first (git push -u <remote> <branch>)" >&2
  exit 1
fi
if ! git merge-base --is-ancestor HEAD "$upstream"; then
  echo "error: HEAD is not pushed to ${upstream}; push first" >&2
  exit 1
fi

sha=$(git rev-parse --short HEAD)

docker build --platform "$PLATFORM" -t "${IMAGE}:${sha}" -t "${IMAGE}:latest" proxy/
docker push "${IMAGE}:${sha}"
docker push "${IMAGE}:latest"

echo "pushed ${IMAGE}:${sha} and ${IMAGE}:latest"
