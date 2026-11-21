#!/bin/sh
# Assembles the Kubernetes image's files under $ROOTFS, at build time, in a
# throwaway stage built from the runtime stage. The image itself is Docker's
# distroless hardened Node image with this tree copied on top: no shell, no
# package manager, only node and what the platform loads.
#
# It copies whole Alpine packages, never loose libraries, and writes their
# entries into the base's package database, so image scanners list every
# package the image holds, at its real version:
# - git, git-daemon (git-http-backend) and git-init-template, which the skill
#   marketplace runs
# - the packages that own a shared library that the native addons under /app,
#   kubectl, dagger or git load, followed until nothing new is needed
# A package the base already has is replaced by the runtime's copy, which the
# runtime stage may have upgraded past the base. busybox is never copied: it
# is the shell this image leaves out, and git runs without it.
#
# Also: /app, the writable directories, the CA bundles, and the passwd and
# group files with the archestra user (UID 10001).
#
# Usage: ROOTFS=/rootfs BASE=/tmp/base sh build-slim-rootfs.sh
#   BASE holds the base image's lib/apk/db/installed, etc/passwd and etc/group.
set -eu

: "${ROOTFS:?}" "${BASE:?}"
DB=/lib/apk/db/installed
mkdir -p "$ROOTFS"

# --- Packages ---------------------------------------------------------------

owner() {
    # `apk info --who-owns` prints "<path> is owned by <name>-<version>".
    apk info --who-owns "$1" 2>/dev/null | sed -n 's/.* is owned by //p' | head -n1
}

package_name() {
    # The name of the installed package whose name-version is $1.
    awk -v want="$1" '/^P:/ { name = substr($0, 3) } /^V:/ && name "-" substr($0, 3) == want { print name; exit }' "$DB"
}

elf_files() {
    # ELF files under the given paths that are executables or shared objects.
    scanelf --recursive --nobanner --format '%F' "$@" 2>/dev/null
}

needed_paths() {
    # Paths of the shared libraries the given ELF files need, as the musl
    # loader would find them.
    scanelf --nobanner --needed --format '%n' "$@" 2>/dev/null | tr ',' '\n' | sort -u |
        while read -r soname; do
            [ -n "$soname" ] || continue
            for directory in /lib /usr/lib /usr/local/lib; do
                if [ -e "$directory/$soname" ]; then
                    echo "$directory/$soname"
                    break
                fi
            done
        done
}

# git-init-template holds the templates `git init` copies into a new repository.
packages="git git-daemon git-init-template"
elves=$(elf_files /app /usr/local/bin/kubectl /usr/local/bin/dagger /usr/bin/git /usr/libexec/git-core)
seen=""
# Follow library dependencies until no new library appears.
while [ -n "$elves" ]; do
    next=""
    for library in $(needed_paths $elves); do
        resolved=$(readlink -f "$library")
        case " $seen " in *" $resolved "*) continue ;; esac
        seen="$seen $resolved"
        next="$next $resolved"
        name=$(package_name "$(owner "$resolved")")
        if [ -z "$name" ]; then
            echo "ERROR: no package owns $resolved" >&2
            exit 1
        fi
        case " $packages " in *" $name "*) ;; *) packages="$packages $name" ;; esac
    done
    elves=$next
done
packages=$(echo "$packages" | tr ' ' '\n' | grep -v -x -e '' -e busybox | sort -u | tr '\n' ' ')
echo "Packages copied into the Kubernetes image: $packages"

# Every directory and file of each package, from its database entry (F: is a
# directory, R: a file in it); `apk info --contents` leaves some files out,
# such as git's templates.
awk -v copy=" $packages " '
    /^P:/ { keep = index(copy, " " substr($0, 3) " ") > 0 }
    keep && /^F:/ { directory = substr($0, 3); print directory }
    keep && /^R:/ { print directory "/" substr($0, 3) }
' "$DB" | sort -u > /tmp/slim-package-files
(cd / && tar --no-recursion -cf - -T /tmp/slim-package-files) | tar -xf - -C "$ROOTFS"

# The base's package entries, minus the ones replaced, then the copied ones.
mkdir -p "$ROOTFS/lib/apk/db"
awk -v replace=" $packages " '
    BEGIN { RS = ""; ORS = "\n\n" }
    { split($0, lines, "\n"); for (i in lines) if (lines[i] ~ /^P:/) name = substr(lines[i], 3) }
    index(replace, " " name " ") == 0 { print }
' "$BASE/installed" > "$ROOTFS$DB"
awk -v copy=" $packages " '
    BEGIN { RS = ""; ORS = "\n\n" }
    { split($0, lines, "\n"); for (i in lines) if (lines[i] ~ /^P:/) name = substr(lines[i], 3) }
    index(copy, " " name " ") > 0 { print }
' "$DB" >> "$ROOTFS$DB"
for name in $packages; do
    grep -q -x "P:$name" "$ROOTFS$DB" || { echo "ERROR: $name has no database entry" >&2; exit 1; }
done

# --- Platform files -----------------------------------------------------------

mkdir -p "$ROOTFS/usr/local/bin" "$ROOTFS/etc/ssl/certs"
cp -a /usr/local/bin/kubectl /usr/local/bin/dagger "$ROOTFS/usr/local/bin/"
cp -a /app "$ROOTFS/app"
for directory in /run/archestra /home/archestra; do
    mkdir -p "$ROOTFS$directory"
    chown 10001:0 "$ROOTFS$directory"
    chmod 0775 "$ROOTFS$directory"
done
# The system store with the cloud database CA bundle appended (the runtime
# stage's RUN), and that bundle on its own for NODE_EXTRA_CA_CERTS.
cp /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/cloud-database-ca-bundle.pem "$ROOTFS/etc/ssl/certs/"

# The base's users and groups plus archestra. No login shell: there is none.
cp "$BASE/passwd" "$BASE/group" "$ROOTFS/etc/"
echo "archestra:x:10001:10001:archestra:/home/archestra:/sbin/nologin" >> "$ROOTFS/etc/passwd"
echo "archestra:x:10001:archestra" >> "$ROOTFS/etc/group"

# The shell scripts stay behind: nothing in this image can run them.
rm -f "$ROOTFS/app/backend/scripts/start-production.sh"
if find "$ROOTFS/app" -name '*.sh' -path '*/scripts/*' | grep -q .; then
    find "$ROOTFS/app" -name '*.sh' -path '*/scripts/*' >&2
    echo "ERROR: shell scripts in the Kubernetes image; it has no shell to run them" >&2
    exit 1
fi
