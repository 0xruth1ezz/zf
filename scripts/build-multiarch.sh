#!/usr/bin/env bash
set -euo pipefail

image="${IMAGE:-zf:latest}"
platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
build_version="${BUILD_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || printf dev)}"

if [ "${PUSH:-0}" = "1" ]; then
  docker buildx build \
    --platform "$platforms" \
    --build-arg "BUILD_VERSION=$build_version" \
    --tag "$image" \
    --push \
    .
else
  echo "PUSH=1 is not set, so Docker cannot load a single multi-arch manifest locally."
  echo "Building one local image per architecture instead."
  docker buildx build --platform linux/amd64 --build-arg "BUILD_VERSION=$build_version" --tag "${image}-amd64" --load .
  docker buildx build --platform linux/arm64 --build-arg "BUILD_VERSION=$build_version" --tag "${image}-arm64" --load .
fi
