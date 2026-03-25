#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_EXT_DIR="$HOME/.pi/agent/extensions"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"

echo "Installing pi-mux from $REPO_DIR"

# Pi extension
mkdir -p "$PI_EXT_DIR"
if [ -L "$PI_EXT_DIR/xreview.ts" ] || [ -e "$PI_EXT_DIR/xreview.ts" ]; then
  rm -f "$PI_EXT_DIR/xreview.ts"
fi
ln -s "$REPO_DIR/extensions/xreview.ts" "$PI_EXT_DIR/xreview.ts"
echo "  -> $PI_EXT_DIR/xreview.ts"

# Claude skill
mkdir -p "$CLAUDE_SKILLS_DIR"
if [ -d "$CLAUDE_SKILLS_DIR/pi-review" ] && [ ! -L "$CLAUDE_SKILLS_DIR/pi-review" ]; then
  echo "Error: $CLAUDE_SKILLS_DIR/pi-review is a real directory, not a symlink. Remove it manually first."
  exit 1
fi
if [ -L "$CLAUDE_SKILLS_DIR/pi-review" ] || [ -e "$CLAUDE_SKILLS_DIR/pi-review" ]; then
  rm -f "$CLAUDE_SKILLS_DIR/pi-review"
fi
ln -s "$REPO_DIR/skills/pi-review" "$CLAUDE_SKILLS_DIR/pi-review"
echo "  -> $CLAUDE_SKILLS_DIR/pi-review"

echo "Done. Reload Pi (/reload) and Claude Code to pick up changes."
