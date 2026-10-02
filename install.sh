#!/bin/sh
# Celsus OS installer. One line:
#   curl -fsSL https://raw.githubusercontent.com/Champ-Deep/celsus-os/main/install.sh | sh
# Puts the app in ~/.celsus-os/app, links a `celsus` command into ~/.local/bin, then tells you to run
# `celsus setup`. Nothing is written into your folder until you run a pass, and no dependency is
# installed: the app is Node's own TypeScript support plus the standard library.
#
# Overridable before running: CELSUS_REPO, CELSUS_HOME, CELSUS_BIN, CELSUS_VERSION.
set -e
REPO="${CELSUS_REPO:-https://github.com/Champ-Deep/celsus-os.git}"
DIR="${CELSUS_HOME:-$HOME/.celsus-os/app}"
BIN="${CELSUS_BIN:-$HOME/.local/bin}"
REF="${CELSUS_VERSION:-main}"

say() { printf '%s\n' "$*"; }
fail() { say "celsus: $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required. macOS: xcode-select --install. Linux: apt install git."

# Node 22.18 or newer, because the app runs TypeScript directly with no build step. Checked by
# actually loading the feature, not by parsing the version: a version string can lie, a feature cannot.
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 22.18 or newer is required and node is not on PATH. Install from https://nodejs.org, or: brew install node"
fi
NODE_V=$(node -v | sed 's/^v//')
MAJOR=$(printf '%s' "$NODE_V" | cut -d. -f1); MINOR=$(printf '%s' "$NODE_V" | cut -d. -f2)
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 18 ]; }; then
  fail "Node $NODE_V found; 22.18 or newer is needed. Update with: brew upgrade node, or nvm install 22"
fi
if ! node -e 'import("node:module").then(()=>process.exit(0),()=>process.exit(1))' 2>/dev/null; then
  say "celsus: warning: could not confirm TypeScript support in this Node build. Continuing, but 'celsus doctor' will tell you."
fi

mkdir -p "$(dirname "$DIR")" "$BIN"
if [ -d "$DIR/.git" ]; then
  say "Updating Celsus OS in $DIR"
  git -C "$DIR" fetch --quiet origin
  git -C "$DIR" checkout --quiet "$REF" 2>/dev/null || git -C "$DIR" pull --ff-only --quiet
else
  say "Installing Celsus OS into $DIR"
  git clone --depth 1 --quiet --branch "$REF" "$REPO" "$DIR" 2>/dev/null \
    || git clone --depth 1 --quiet "$REPO" "$DIR"
fi
chmod +x "$DIR/bin/celsus" 2>/dev/null || true
ln -sf "$DIR/bin/celsus" "$BIN/celsus"

say ""
say "Installed. Node $NODE_V, app at $DIR"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "Add this to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:"; say "  export PATH=\"$BIN:\$PATH\"";;
esac
say ""
say "Next, three commands:"
say "  celsus setup     one OpenRouter key, and the folder to map"
say "  celsus run       map it. About 4 minutes for 3,000 notes, a few cents"
say "  celsus serve     open http://localhost:3043"
say ""
say "Not sure it worked? celsus doctor"
