---
name: pi-review
description: "Handle code review findings from Pi (another AI agent) received via tmux. Triggers when you see text with [P0]-[P3] priority tags and a verdict line, or text prefixed with '[pi-review findings]'. Also use when the user says 'handle pi findings', 'fix pi review', or 'respond to pi'. If you see prioritized code findings pasted into your prompt that look like they came from another agent's review, this skill applies."
---

# Pi Review Findings Handler

You received code review findings from Pi, another AI agent running in a tmux pane below yours. Your job: investigate each finding, fix what's valid, then tell Pi what you did and ask for re-review.

## Recognize findings

Findings arrive as text in your prompt containing:
- Priority tags: `[P0]`, `[P1]`, `[P2]`, `[P3]`
- A verdict line: `verdict: correct` or `verdict: needs attention`
- May or may not start with `[pi-review findings]`

If verdict is **"correct"** — nothing to fix. Tell the user Pi found no issues.

## Investigate and fix

For each finding:
1. Read the referenced file and line
2. Decide if the issue is valid — think critically, don't blindly accept
3. If valid: fix it. If you disagree: skip it and note why.

Priority handling:
- **[P0] and [P1]**: Always fix if valid
- **[P2] and [P3]**: Fix if straightforward, skip if it would be a large refactor

Keep fixes minimal and focused. Do NOT add tests, docstrings, or refactor surrounding code unless the finding specifically requires it.

## Respond to Pi via tmux

After fixing, find Pi's tmux pane and send a single message.

### Find Pi's pane ID

```bash
MUX_DIR="${PI_MUX_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-mux-$(id -u)}"
cat "$MUX_DIR/config.json"
```

If config.json doesn't exist, auto-detect:
```bash
tmux list-panes -F '#{pane_id} #{pane_top}'
```
Sort by `pane_top` — smallest = your pane (Claude), largest = Pi's pane. Write the config for next time:
```bash
mkdir -p "$MUX_DIR"
echo '{"claudePane":"<your-id>","piPane":"<pi-id>"}' > "$MUX_DIR/config.json"
```

### Send ONE message

Compose a short summary of what you fixed and send it:

```bash
tmux send-keys -t <piPane> 'Done, can you review again? Fixed <list what you fixed briefly>' Enter
```

The message should:
- Start with "Done" or similar acknowledgment
- List what you fixed (e.g. "Fixed P1: null check in auth handler, P2: polling now uses specific run ID")
- End with asking Pi to review again
- Stay under ~300 chars to avoid tmux issues
- Use single quotes for the outer wrapper, avoid single quotes inside the message

If you skipped findings, mention them: "Skipped P3: style preference, disagree."

That's it. No loops, no commits, no extra orchestration. Fix, respond, done.
