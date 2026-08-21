#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

# Ensure the app home is owned by the runtime user BEFORE dropping
# privileges -- not only after a UID/GID remap. Repair each writable mount
# independently and prune every nested mount from its parent traversal. This
# preserves intentionally read-only credential/config mounts while still
# repairing fresh volumes, restored descendants, and GID-only remaps.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ]; then
    mount_table="$(findmnt --target "$home_dir" --submounts --noheadings --raw --output TARGET,VFS-OPTIONS)"

    repair_tree_ownership() {
        tree=$1
        set -- "$tree"
        while read -r mount_target mount_options; do
            case "$mount_target" in
                "$tree"/*) set -- "$@" -path "$mount_target" -prune -o ;;
            esac
        done <<EOF
$mount_table
EOF
        set -- "$@" \( ! -user node -o ! -group node \) -exec chown node:node {} +
        find "$@"
    }

    repair_tree_ownership "$home_dir"
    while read -r mount_target mount_options; do
        case "$mount_target:$mount_options" in
            "$home_dir"/*:rw|"$home_dir"/*:rw,*|"$home_dir"/*:*,rw|"$home_dir"/*:*,rw,*)
                repair_tree_ownership "$mount_target"
                ;;
        esac
    done <<EOF
$mount_table
EOF
fi

exec gosu node "$@"
