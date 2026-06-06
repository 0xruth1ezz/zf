# syntax=docker/dockerfile:1.7

FROM rust:1.94-bookworm AS rust-builder

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV NODE_ENV=production \
    HEADLESS=1 \
    USE_CHROME=0 \
    REPORT_HOST=0.0.0.0 \
    REPORT_PORT=8787 \
    CRAWL_INTERVAL_SECONDS=3600 \
    RUN_ON_START=1 \
    ZF_PROFILE_DIR=/data/browser-profile \
    ZF_ENGAGED_DB=/data/engaged-lotteries.sqlite \
    ZF_ENGAGED_HTML=/data/engaged-lotteries.html \
    CRAWLEE_STORAGE_DIR=/data/crawlee-storage

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY engaged-store.js view-engaged-lotteries.js zfrontier-lottery-crawler.js ./
COPY --from=rust-builder /src/target/release/zfrontier-report-server /usr/local/bin/zfrontier-report-server
COPY docker/entrypoint.sh /usr/local/bin/zfrontier-entrypoint

RUN chmod +x /usr/local/bin/zfrontier-entrypoint \
    && mkdir -p /data

EXPOSE 8787
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/zfrontier-entrypoint"]

