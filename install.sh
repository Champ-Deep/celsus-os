#!/bin/sh
# Celsus OS installer. One line:
#   curl -fsSL https://raw.githubusercontent.com/Champ-Deep/celsus-os/main/install.sh | sh
# Puts the app in ~/.celsus-os/app, links a `celsus` command into ~/.local/bin, then tells you to run `celsus setup`.
# Nothing is written into your vault until you run a pass. No dependencies beyond git and Node 22.18 or newer.
set -e
REPO="${CELSUS_REPO:-https://github.com/Champ-Deep/celsus-os.git}"
DIR="${CELSUS_HOME:-$HOME/.celsus-os/app}"
BIN="${CELSUS_BIN:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { say "celsus: $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required. macOS: xcode-select --install. Linux: apt install git."
command -v node >/dev/null 2>&1 || fail "Node.js 22.18 or newer is required. https://nodejs.org (LTS) or: brew install node"
NODE_V=$(node -v | sed 's/^v//')
MAJOR=$(printf '%s' "$NODE_V" | cut -d. -f1); MINOR=$(printf '%s' "$NODE_V" | cut -d. -f2)
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 18 ]; }; then
  fail "Node $NODE_V found; 22.18 or newer is needed (it runs TypeScript directly). Update with: brew upgrade node, or nvm install 22"
fi

mkdir -p "$(dirname "$DIR")" "$BIN"
if [ -d "$DIR/.git" ]; then
  say "Updating Celsus OS in $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  say "Installing Celsus OS into $DIR"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi
chmod +x "$DIR/bin/celsus"
ln -sf "$DIR/bin/celsus" "$BIN/celsus"

say ""
say "Installed. Node $NODE_V, app at $DIR"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "Add this to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:"; say "  export PATH=\"$BIN:\$PATH\"";;
esac
say ""
say "Next:"
say "  celsus setup     paste your OpenRouter key, point it at your Obsidian vault"
say "  celsus doctor    check the machine end to end"
say "  celsus run       first pass over the vault (about 4 minutes, names only leave the machine)"
say "  celsus serve     open http://localhost:3043"
