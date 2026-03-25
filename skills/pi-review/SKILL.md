---
name: pi-review
description: "Start a cross-agent review loop where Pi reviews your code via tmux. Use when the user says '/pi-review', 'ask pi to review', 'review loop', 'cross-review', or wants Pi to review code changes. Supports: '/pi-review' (auto-detect), '/pi-review branch:develop' (diff against specific base), '/pi-review commit:3' (last N commits). Requires tmux with Claude in the top pane and Pi in the bottom pane."
---

# Pi Cross-Review Loop

Trigger Pi (in the bottom tmux pane) to review code changes. Read findings, fix issues, re-trigger. Loop until Pi says "correct" or max 5 rounds.

## Shared directory

First, resolve the mux directory (Pi uses the same logic):
```bash
MUX_DIR="${PI_MUX_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-mux-$(id -u)}"
mkdir -p "$MUX_DIR"
```
Use `$MUX_DIR` for all file paths below.

## Modes

Parse `$ARGUMENTS` to determine the review mode:

- **No args** (`/pi-review`): auto-detect. Pi figures out branch diff + uncommitted.
- **`branch:<name>`** (`/pi-review branch:develop`): review against specific base branch.
- **`commit:<N>`** (`/pi-review commit:3`): review the last N commits.

The mode determines what argument to pass to Pi's `/xreview` command:
- No args → `/xreview`
- `branch:develop` → `/xreview branch develop`
- `commit:3` → `/xreview commit 3`

## Setup Check

1. Verify tmux is available:
```bash
tmux list-panes -F '#{pane_id} #{pane_top}' 2>/dev/null
```

2. If `$MUX_DIR/config.json` does not exist, create it by detecting panes:
   - Parse `tmux list-panes -F '#{pane_id} #{pane_top}'`
   - Sort by `pane_top` ascending
   - First (smallest top) = Claude pane, last (largest top) = Pi pane
   - Write `{ "claudePane": "<id>", "piPane": "<id>" }` to `$MUX_DIR/config.json`

3. Read the config to get `piPane` ID.

## Review Loop (max 5 rounds)

For each round:

### Step 1: Trigger Pi
```bash
echo "idle" > "$MUX_DIR/status"
tmux send-keys -t <piPane> '/xreview <mode-args>' Enter
```
Where `<mode-args>` is empty, `branch <name>`, or `commit <N>` based on the parsed mode.

### Step 2: Wait for Pi to finish
Poll the status file every 3 seconds, timeout after 180 seconds:
```bash
cat "$MUX_DIR/status"
```
Wait until status reads `done` or `error`. Do NOT proceed until Pi is done.

### Step 3: Receive findings
Pi will paste findings directly into your prompt via tmux. If that doesn't arrive within 10 seconds after status=done, fall back to reading the file:
```bash
cat "$MUX_DIR/findings.md"
```

### Step 4: Analyze and act
- Parse the findings for priority tags: [P0], [P1], [P2], [P3]
- Look for the **verdict** at the end: "correct" or "needs attention"
- If verdict is **"correct"** (no blocking issues): stop the loop, tell the user "Pi review passed - no blocking issues found"
- If verdict is **"needs attention"**: fix all P0 and P1 issues, then continue to next round
- For P2/P3 issues: fix if straightforward, otherwise note them for the user

### Step 5: Commit fixes
After fixing issues, commit them so Pi can see a clean diff on the next round:
```bash
git add -A
git commit -m "fix: address pi review round N findings"
```
Where N is the current round number.

### Step 6: Loop or stop
- After committing, go back to Step 1 for the next round
- If this was round 5 and issues remain, stop and tell the user:
  "Reached max 5 review rounds. Run /pi-review again to continue."

## Important Notes

- Do NOT ask the user for confirmation between rounds. The loop is autonomous.
- Do NOT modify test files or add new tests unless a finding specifically requires it.
- Keep fixes minimal and focused on what Pi flagged.
- If Pi flags something you disagree with, skip it and note why.
- If status reads `error`, tell the user Pi encountered an error and stop.
- The base branch for review is auto-detected by Pi (defaults to main/master).
- To review against a specific branch, send: `tmux send-keys -t <piPane> '/xreview develop' Enter`
