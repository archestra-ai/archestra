# Build context is ai-labs (the reduced build reuses the workspace lockfile).
#   docker build -f baton/baton-proxy/Dockerfile -t baton-proxy:poc .
# Pin to bookworm so the runtime glibc (debian:bookworm-slim) matches the
# build glibc — rust:1-slim tracks trixie and links a newer glibc.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY baton/baton-core baton-core
COPY baton/baton-contracts baton-contracts
COPY baton/baton-proxy baton-proxy
COPY Cargo.lock baton-proxy/Cargo.lock
# The copied crates inherit workspace lints, but the reduced image build does
# not copy the workspace manifest. Lint enforcement remains in workspace CI.
RUN sed -i '/^\[lints\]$/,+1d' baton-core/Cargo.toml baton-contracts/Cargo.toml baton-proxy/Cargo.toml
RUN cargo build --release --locked --manifest-path baton-proxy/Cargo.toml --bin baton-proxy

FROM debian:bookworm-slim
# reqwest/rustls loads trust roots from the system store; the slim image has
# none, so HTTPS to the upstream provider fails without this.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/baton-proxy/target/release/baton-proxy /usr/local/bin/baton-proxy
ENTRYPOINT ["baton-proxy"]
