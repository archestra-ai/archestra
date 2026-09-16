# Pinned Herdr runtime

The maintained images install the Linux amd64 or arm64 binary from [Herdr v0.9.0](https://github.com/herdrdev/herdr/releases/tag/v0.9.0), source commit `b99002ac99b09e00b4ca692436cb15a6b0d676f1`. The Dockerfile checks each asset's SHA-256 and byte count. The terminal helper checks server version 0.9.0 and socket protocol 22 before accepting work.

`notices/herdr-v0.9.0-linux-notices.tar.gz` contains the release's Apache-2.0 license and dependency notices, including the native terminal renderer. Its README records the audited dependency inventory and source provenance. The image verifies the archive digest and installs its contents in `/usr/share/licenses/herdr`.

To update Herdr, audit the exact release's dependency and native-library licenses, regenerate the notices bundle, update the asset and archive checksums, and review the socket protocol used by `archestra-terminal` and `archestra-claude-account`. Run the terminal, recorder, sign-in, native client, and backend compatibility checks on both supported architectures before changing the pin.
