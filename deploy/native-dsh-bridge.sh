#!/bin/sh
set -eu
export DSH_PERMISSION_MODE=danger-full-access
exec /opt/dsh/node_modules/.bin/dsh --patch "$HOME/.clawchat-dsh/models.patch.yml" "$@"
