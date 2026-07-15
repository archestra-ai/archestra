# Build context is this directory (the crate is standalone):
#   docker build -t notify-mcp:poc demo/kagent/notify-mcp
# Pin to bookworm so the runtime glibc (debian:bookworm-slim) matches the
# build glibc — rust:1-slim tracks trixie and links a newer glibc.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --bin notify-mcp

FROM debian:bookworm-slim
# reqwest/rustls loads trust roots from the system store; the slim image has
# none, so HTTPS delivery targets would fail without this.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/notify-mcp /usr/local/bin/notify-mcp
ENTRYPOINT ["notify-mcp"]
