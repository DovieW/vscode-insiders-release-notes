# Minimal runner image for `act` that can execute Node20-based GitHub Actions
# while staying much smaller than full ubuntu runner images.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    tar \
    gzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Some actions expect a HOME directory.
ENV HOME=/root
