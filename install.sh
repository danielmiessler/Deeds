#!/bin/sh
# Install the deeds CLI for your own user. No elevated privileges are used.
#   curl -fsSL https://raw.githubusercontent.com/danielmiessler/deeds/main/install.sh | sh
#
# Puts the CLI in ~/.local/share/deeds and a `deeds` command in ~/.local/bin.
# Downloads one tarball and its sha256 from the project's GitHub release, refuses to install if they
# disagree, then installs the locked dependencies with `bun install --frozen-lockfile`.
#
# Settings (all optional):
#   DEEDS_BASE_URL  where deeds-cli.tar.gz and deeds-cli.tar.gz.sha256 are fetched from
#   DEEDS_SHA256    pin the expected checksum yourself instead of trusting the published one
#   DEEDS_HOME      install folder (default ~/.local/share/deeds)
#   DEEDS_BIN       folder for the `deeds` command (default ~/.local/bin)
set -eu

BASE_URL="${DEEDS_BASE_URL:-https://github.com/danielmiessler/deeds/releases/latest/download}"
INSTALL_DIR="${DEEDS_HOME:-$HOME/.local/share/deeds}"
BIN_DIR="${DEEDS_BIN:-$HOME/.local/bin}"
TARBALL="deeds-cli.tar.gz"

fail() { echo "deeds install: $*" >&2; exit 1; }

for tool in curl tar cksum; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
command -v bun >/dev/null 2>&1 || fail "bun is required (https://bun.sh); install it, then run this again"

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required to check the download"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deeds-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "deeds install: downloading $TARBALL"
curl -fsSL "$BASE_URL/$TARBALL" -o "$WORK/$TARBALL" || fail "could not download $BASE_URL/$TARBALL"
if [ -n "${DEEDS_SHA256:-}" ]; then
  expected="$DEEDS_SHA256"
else
  curl -fsSL "$BASE_URL/$TARBALL.sha256" -o "$WORK/$TARBALL.sha256" || fail "could not download the published checksum"
  expected="$(cut -d ' ' -f 1 "$WORK/$TARBALL.sha256" | head -n 1)"
fi
actual="$(sha256_of "$WORK/$TARBALL")"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  fail "checksum mismatch (expected ${expected:-none}, got $actual); nothing was installed"
fi
echo "deeds install: checksum ok"

# Unpack and install dependencies beside the final folder, then swap it in, so a failure leaves any
# existing install untouched.
mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
STAGE="$INSTALL_DIR.new.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$WORK" "$STAGE"' EXIT INT TERM
tar -xzf "$WORK/$TARBALL" -C "$STAGE" || fail "could not unpack the download"
[ -f "$STAGE/src/cli.ts" ] && [ -f "$STAGE/bun.lock" ] || fail "the download is not a deeds CLI"
(cd "$STAGE" && bun install --frozen-lockfile --production --silent) || fail "dependency install failed"
printf '%s\n' "$(cat "$STAGE/bun.lock" "$STAGE/package.json" | cksum)" > "$STAGE/node_modules/.deeds-lock"
rm -rf "$INSTALL_DIR"
mv "$STAGE" "$INSTALL_DIR"

LAUNCHER="$BIN_DIR/deeds"
cat > "$LAUNCHER" <<LAUNCH
#!/bin/sh
exec bun --no-env-file "$INSTALL_DIR/src/cli.ts" "\$@"
LAUNCH
chmod 755 "$LAUNCHER"

echo "deeds install: installed to $INSTALL_DIR"
echo "deeds install: command at $LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "deeds install: add $BIN_DIR to your PATH to run \`deeds\`" ;;
esac
"$LAUNCHER" version
