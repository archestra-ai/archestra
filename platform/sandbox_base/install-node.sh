#!/bin/sh
set -eu

# Shared by the baked image and the runtime-built fallback sandbox.
node_version=24.22.1
case "$(uname -m)" in
  x86_64)
    node_arch=x64
    node_checksum=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
    ;;
  aarch64)
    node_arch=arm64
    node_checksum=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e
    ;;
  *)
    echo "Unsupported Node architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

node_archive="/tmp/node-v${node_version}-linux-${node_arch}.tar.xz"
curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz" -o "$node_archive"
echo "${node_checksum}  ${node_archive}" | sha256sum -c -
tar -xJf "$node_archive" -C /usr/local --strip-components=1
rm "$node_archive"
ln -sf /usr/local/bin/node /usr/local/bin/nodejs

# npm's separate bundled Undici 6 lags the fix for excessive content encodings.
# Remove Corepack: the sandbox exposes npm, and its old copy is unnecessary.
undici_archive=/tmp/undici-6.29.1.tgz
undici_dir=$(mktemp -d)
curl -fsSL https://registry.npmjs.org/undici/-/undici-6.29.1.tgz -o "$undici_archive"
echo "29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f  ${undici_archive}" | sha256sum -c -
tar -xzf "$undici_archive" -C "$undici_dir"
rm -rf /usr/local/lib/node_modules/npm/node_modules/undici /usr/local/lib/node_modules/corepack
mv "$undici_dir/package" /usr/local/lib/node_modules/npm/node_modules/undici
rm -rf "$undici_dir" "$undici_archive"
rm -f /usr/local/bin/corepack
node --version
npm --version
node -e "if (require('/usr/local/lib/node_modules/npm/node_modules/undici/package.json').version !== '6.29.1') process.exit(1)"

# The official Node archive also bundles brace-expansion below the patched 5.0.11 floor.
brace_archive=/tmp/brace-expansion-5.0.12.tgz
brace_dir=$(mktemp -d)
curl -fsSL https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz -o "$brace_archive"
echo "ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4  ${brace_archive}" | sha256sum -c -
tar -xzf "$brace_archive" -C "$brace_dir"
rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion
mv "$brace_dir/package" /usr/local/lib/node_modules/npm/node_modules/brace-expansion
rm -rf "$brace_dir" "$brace_archive"
node -e "if (require('/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json').version !== '5.0.12') process.exit(1)"
