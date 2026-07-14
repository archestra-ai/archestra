# Build context is ai-labs/baton (the crate depends on sibling path crates).
#   docker build -f baton-proxy/Dockerfile -t baton-proxy:poc .
# Pin to bookworm so the runtime glibc (debian:bookworm-slim) matches the
# build glibc — rust:1-slim tracks trixie and links a newer glibc.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY baton-core baton-core
COPY baton-contracts baton-contracts
COPY baton-proxy baton-proxy
# baton-core inherits `[workspace.lints]` from the ai-labs workspace, which is
# outside this minimal build context. Drop the inheritance here — lint
# enforcement is a CI concern, not the image's; this does not affect behavior.
RUN sed -i '/^\[lints\]$/,+1d' baton-core/Cargo.toml
RUN cargo build --release --manifest-path baton-proxy/Cargo.toml --bin baton-proxy

FROM debian:bookworm-slim
# reqwest/rustls loads trust roots from the system store; the slim image has
# none, so HTTPS to the upstream provider fails without this.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/baton-proxy/target/release/baton-proxy /usr/local/bin/baton-proxy
ENTRYPOINT ["baton-proxy"]
