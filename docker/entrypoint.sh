#!/bin/sh
set -eu
umask 077

mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config/dalang"
rm -f "$XDG_RUNTIME_DIR/bus"
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile

keyring_password="$HOME/.config/dalang/keyring-password"
if [ ! -s "$keyring_password" ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$keyring_password"
fi
gnome-keyring-daemon --unlock --components=secrets < "$keyring_password" > /dev/null
gdbus wait --session --timeout 10 org.freedesktop.secrets

# Fail at startup if Docker's kernel policy cannot provide the existing per-project sandbox.
bwrap --unshare-pid --unshare-ipc --ro-bind / / --dev /dev --proc /proc /bin/true
exec "$@"
