# itemizer-bridge

The Claude Code half of Claude Chat Itemizer. It runs inside each Claude Code session and sends the chat items you submit from the Itemizer sidebar in VS Code into that session's chat, one at a time, as real turns.

For each item it:

- switches the model and effort for that item's turn only (through a `turn.step` hook), then hands the session back its own settings;
- adds text attachments as hidden context and lists image and PDF attachments for Claude to open with its Read tool, which it allows without a prompt for exactly those files;
- applies the item's tool policy: read-only denies file edits and asks before shell commands.

It stays dormant in sessions whose folder has no Itemizer window open. It exchanges files with the extension under `~/.claude/itemizer/v1` (or `ITEMIZER_BRIDGE_DIR`).

## Install

The VS Code extension installs it: run **Chat Itemizer: Set Up Claude Bridge**, then open a new Claude tab. That copies this folder to `~/.claude/itemizer/plugin` and names it in `CLAUDE_CODE_PLUGIN_DIRS` through the `claudeCode.environmentVariables` setting.

For a terminal session: `claude --plugin-dir <path to this folder>`.

## Commands

- `/itemizer-run <claim id>`: starts a batch the extension prepared for a new conversation. The extension types it into a new Claude tab when it cannot hand the batch over automatically.
