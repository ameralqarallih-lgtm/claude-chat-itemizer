# Changelog

## 0.3.1 (2026-10-28)

### Fixed
- A long reply preview in an expanded run no longer makes the sidebar wider than its panel. Previews are cut to one line with an ellipsis.

### Docs
- README screenshots now show a real-world workspace: the sidebar, the item editor and the submit dialog.

## 0.3.0 (2026-10-28)

First public release.

### Chat items
- Items with a title, prompt, attachments, model, effort, tool policy and hidden instructions.
- Settings resolve **Defaults → Category → Item**. The editor shows where each value comes from and can reset an override.
- Categories with colors and their own settings. Drag and drop within and between categories, with keyboard support.
- Attachments by picker, drag and drop, or **Ctrl+V** (screenshots, copied files, text). Stored as content-addressed copies.
- **Hide sent items.** Items get a "sent" mark when they finish.
- Export and import (merge or replace), attachments included.

### Sending
- **Send to:** pick which open Claude chat receives items, or follow the most recently used one. Chats are named by their Claude Code title, or by their first prompt.
- **Quick** submit with the chat's own settings, for the selection or a single item.
- **Submit…** with three modes: one conversation in order, a new conversation per item (1–4 at once), or all in one message.
- Per-item model and effort, applied for that turn only.
- Text attachments are given to Claude as context. Images and PDFs are opened by Claude's Read tool, which the bridge allows without a prompt.
- Read-only and auto-accept-edits tool policies.

### Runs
- Run history grouped into Running, Today, Yesterday and Earlier, collapsible at every level.
- Per-item status, the model that answered, and a preview of the reply.
- Stop, Cancel, Clear finished, and Select these items to send again.

### Bridge plugin (itemizer-bridge 0.3.0)
- Stays dormant unless an Itemizer window is open on its folder.
- Reports each chat's title, history, model and whether a tab shows it, so pickers skip background processes.
- Adds attachment context before sending, so Claude always sees it ahead of the prompt.
- Recovers a running item after a plugin reload, and closes out work on `/clear` or exit.
