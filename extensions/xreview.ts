/**
 * Cross-Review Extension (pi-mux)
 *
 * Enables Claude Code <-> Pi review loops via tmux.
 * Claude sends `/xreview` to Pi's pane, Pi reviews branch diff,
 * then pastes findings back into Claude's pane.
 *
 * Commands:
 * - `/xreview [branch]` — run branch diff review, send findings to Claude via tmux
 * - `/mux-init` — auto-detect/confirm tmux pane layout, write config
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

const MUX_DIR =
  process.env.PI_MUX_DIR ||
  path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp", `pi-mux-${process.getuid()}`);
const CONFIG_PATH = path.join(MUX_DIR, "config.json");
const FINDINGS_PATH = path.join(MUX_DIR, "findings.md");
const STATUS_PATH = path.join(MUX_DIR, "status");

type MuxConfig = {
  claudePane: string;
  piPane: string;
};

let xreviewActive = false;
let xreviewMessageCount = 0;

async function ensureDir() {
  await fs.mkdir(MUX_DIR, { recursive: true, mode: 0o700 });
  // Verify the dir is owned by us and not a symlink
  const stat = await fs.lstat(MUX_DIR);
  if (stat.isSymbolicLink()) {
    throw new Error(`${MUX_DIR} is a symlink — refusing to use it`);
  }
  if (stat.uid !== process.getuid()) {
    throw new Error(`${MUX_DIR} is not owned by current user — refusing to use it`);
  }
}

async function writeStatus(status: string) {
  await ensureDir();
  await fs.writeFile(STATUS_PATH, status, "utf8");
}

async function readConfig(): Promise<MuxConfig | null> {
  try {
    await ensureDir();
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as MuxConfig;
  } catch {
    return null;
  }
}

async function writeConfig(config: MuxConfig) {
  await ensureDir();
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

async function detectPanes(
  pi: ExtensionAPI,
): Promise<MuxConfig | null> {
  const { stdout, code } = await pi.exec("tmux", [
    "list-panes",
    "-F",
    "#{pane_id} #{pane_top}",
  ]);
  if (code !== 0 || !stdout.trim()) return null;

  const panes = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [id, top] = line.trim().split(" ");
      return { id, top: parseInt(top, 10) };
    })
    .filter((p) => !isNaN(p.top))
    .sort((a, b) => a.top - b.top);

  if (panes.length < 2) return null;

  return {
    claudePane: panes[0].id,
    piPane: panes[panes.length - 1].id,
  };
}

async function getOrCreateConfig(
  pi: ExtensionAPI,
): Promise<MuxConfig | null> {
  const existing = await readConfig();
  if (existing) return existing;

  const detected = await detectPanes(pi);
  if (!detected) return null;

  await writeConfig(detected);
  return detected;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
  const { stdout, code } = await pi.exec("git", [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "--short",
  ]);
  if (code === 0 && stdout.trim()) {
    return stdout.trim().replace("origin/", "");
  }

  for (const candidate of ["main", "master"]) {
    const { code: c } = await pi.exec("git", [
      "rev-parse",
      "--verify",
      candidate,
    ]);
    if (c === 0) return candidate;
  }

  return "main";
}

async function getMergeBase(
  pi: ExtensionAPI,
  branch: string,
): Promise<string | null> {
  const { stdout: upstream, code: upCode } = await pi.exec("git", [
    "rev-parse",
    "--abbrev-ref",
    `${branch}@{upstream}`,
  ]);

  if (upCode === 0 && upstream.trim()) {
    const { stdout: mb, code } = await pi.exec("git", [
      "merge-base",
      "HEAD",
      upstream.trim(),
    ]);
    if (code === 0 && mb.trim()) return mb.trim();
  }

  const { stdout: mb, code } = await pi.exec("git", [
    "merge-base",
    "HEAD",
    branch,
  ]);
  if (code === 0 && mb.trim()) return mb.trim();

  return null;
}

async function loadProjectReviewGuidelines(
  cwd: string,
): Promise<string | null> {
  let currentDir = path.resolve(cwd);
  while (true) {
    const piDir = path.join(currentDir, ".pi");
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
    const piStats = await fs.stat(piDir).catch(() => null);
    if (piStats?.isDirectory()) {
      try {
        const content = await fs.readFile(guidelinesPath, "utf8");
        return content.trim() || null;
      } catch {
        return null;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToClaudePane(
  pi: ExtensionAPI,
  config: MuxConfig,
  text: string,
) {
  const bufferFile = path.join(MUX_DIR, "paste-buffer.tmp");
  // Prefix with a safe header so Claude doesn't interpret findings as a slash command
  const safeText = `[pi-review findings]\n${text}`;
  await fs.writeFile(bufferFile, safeText, "utf8");

  const load = await pi.exec("tmux", ["load-buffer", bufferFile]);
  if (load.code !== 0) {
    throw new Error(`tmux load-buffer failed: ${load.stderr}`);
  }

  const paste = await pi.exec("tmux", ["paste-buffer", "-t", config.claudePane]);
  if (paste.code !== 0) {
    throw new Error(`tmux paste-buffer failed: ${paste.stderr}`);
  }

  await sleep(500);

  const enter = await pi.exec("tmux", ["send-keys", "-t", config.claudePane, "Enter"]);
  if (enter.code !== 0) {
    throw new Error(`tmux send-keys Enter failed: ${enter.stderr}`);
  }

  await fs.unlink(bufferFile).catch(() => {});
}

const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

## Determining what to flag

Flag issues that:
1. Meaningfully impact accuracy, performance, security, or maintainability.
2. Are discrete and actionable.
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Have provable impact on other parts of the code.
7. Are clearly not intentional changes by the author.

## Untrusted User Input

1. Be careful with open redirects.
2. Always flag SQL that is not parametrized.
3. HTTP fetches with user URLs need protection against local resource access.
4. Escape, don't sanitize if you have the option.

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines.
5. Use suggestion blocks ONLY for concrete replacement code.
6. Explicitly state scenarios where the issue arises.
7. Matter-of-fact tone.
8. Write for quick comprehension.

## Priority levels

Tag each finding with:
- [P0] - Drop everything. Blocking release/operations.
- [P1] - Urgent. Next cycle.
- [P2] - Normal. Fix eventually.
- [P3] - Low. Nice to have.

## Output format

1. List each finding with priority tag, file location, and explanation.
2. Findings must reference locations in the actual diff.
3. At the end, provide verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
4. Ignore trivial style issues.
5. If no qualifying findings, state the code looks good.
6. List every qualifying issue, don't stop at the first.`;

function extractAssistantText(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;

    if (typeof msg.content === "string") return msg.content;

    if (Array.isArray(msg.content)) {
      const texts: string[] = [];
      for (const block of msg.content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string"
        ) {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return "";
}

export default function xreviewExtension(pi: ExtensionAPI): void {
  pi.registerCommand("mux-init", {
    description: "Detect and configure tmux panes for pi-mux cross-review",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const detected = await detectPanes(pi);
      if (!detected) {
        ctx.ui.notify(
          "Could not detect tmux panes. Are you in a tmux session with 2+ panes?",
          "error",
        );
        return;
      }

      const confirm = await ctx.ui.confirm(
        "pi-mux pane layout",
        `Claude (top): ${detected.claudePane}\nPi (bottom): ${detected.piPane}\n\nIs this correct?`,
      );

      if (!confirm) {
        ctx.ui.notify("Cancelled. Adjust pane layout and try again.", "warning");
        return;
      }

      await writeConfig(detected);
      ctx.ui.notify(`Config written to ${CONFIG_PATH}`, "info");
    },
  });

  pi.registerCommand("xreview", {
    description:
      "Review code and send findings to Claude via tmux. Usage: /xreview, /xreview branch <name>, /xreview commit <N>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (xreviewActive) {
        ctx.ui.notify(
          "xreview already active, wait for it to finish",
          "warning",
        );
        return;
      }

      const config = await getOrCreateConfig(pi);
      if (!config) {
        ctx.ui.notify(
          "Could not detect tmux panes. Run /mux-init first.",
          "error",
        );
        return;
      }

      // Parse mode from args: "branch <name>", "commit <N>", bare branch name, or empty (auto)
      const parts = (args?.trim() || "").split(/\s+/);
      const firstArg = parts[0] || "";
      const firstArgLower = firstArg.toLowerCase();
      let mode = firstArgLower || "auto";
      let modeArg = parts[1] || "";

      // Handle bare branch name: "/xreview develop" → branch mode with original case
      if (mode !== "auto" && mode !== "branch" && mode !== "commit") {
        modeArg = firstArg; // preserve original case for branch names
        mode = "branch";
      }

      // 1. Detect current branch
      const { stdout: currentBranchRaw } = await pi.exec("git", [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      const currentBranch = currentBranchRaw.trim();

      // 2. Collect diffs based on mode
      let branchDiff = "";
      let commitDiff = "";
      let branchLabel = "";

      if (mode === "commit") {
        // Review last N commits
        const n = parseInt(modeArg, 10) || 1;
        let { stdout, code } = await pi.exec("git", [
          "diff",
          `HEAD~${n}`,
          "HEAD",
        ]);
        if (code !== 0) {
          // Check if this is a real small repo (not a shallow clone)
          const { stdout: shallowOut } = await pi.exec("git", [
            "rev-parse",
            "--is-shallow-repository",
          ]);
          const isShallow = shallowOut.trim() === "true";

          if (!isShallow) {
            // Genuine small repo — diff from empty tree to include all commits
            const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf899d69f82cf7166";
            const emptyResult = await pi.exec("git", [
              "diff",
              EMPTY_TREE,
              "HEAD",
            ]);
            stdout = emptyResult.stdout;
            code = emptyResult.code;
          } else {
            // Shallow clone — try progressively from HEAD~N down to HEAD~1
            for (let depth = n; depth >= 1; depth--) {
              const tryResult = await pi.exec("git", [
                "diff",
                `HEAD~${depth}`,
                "HEAD",
              ]);
              if (tryResult.code === 0 && tryResult.stdout.trim()) {
                stdout = tryResult.stdout;
                code = tryResult.code;
                break;
              }
            }
            // If none worked, show HEAD commit via diff-tree
            if (code !== 0) {
              const treeResult = await pi.exec("git", [
                "diff-tree",
                "--root",
                "-p",
                "HEAD",
              ]);
              stdout = treeResult.stdout;
              code = treeResult.code;
            }
          }
        }
        if (code === 0 && stdout.trim()) {
          commitDiff = stdout;
        }
        branchLabel = `last ${n} commit${n > 1 ? "s" : ""}`;
      } else {
        // Branch mode (explicit or auto-detect)
        const baseBranch =
          mode === "branch" && modeArg
            ? modeArg
            : await getDefaultBranch(pi);
        branchLabel = baseBranch;
        const isOnBaseBranch = currentBranch === baseBranch;

        if (isOnBaseBranch) {
          // On the base branch: diff local-only commits vs upstream using merge-base
          const { stdout: upstream, code: upCode } = await pi.exec("git", [
            "rev-parse",
            "--abbrev-ref",
            `${baseBranch}@{upstream}`,
          ]);
          if (upCode === 0 && upstream.trim()) {
            const { stdout: mb, code: mbCode } = await pi.exec("git", [
              "merge-base",
              "HEAD",
              upstream.trim(),
            ]);
            if (mbCode === 0 && mb.trim()) {
              const { stdout, code } = await pi.exec("git", [
                "diff",
                mb.trim(),
                "HEAD",
              ]);
              if (code === 0 && stdout.trim()) {
                branchDiff = stdout;
                branchLabel = `${baseBranch} (unpushed vs ${upstream.trim()})`;
              }
            }
          }
          // No upstream configured — review last 3 commits as a reasonable default
          if (!branchDiff) {
            for (let depth = 3; depth >= 1; depth--) {
              const { stdout: fallbackDiff, code: fbCode } = await pi.exec("git", [
                "diff",
                `HEAD~${depth}`,
                "HEAD",
              ]);
              if (fbCode === 0 && fallbackDiff.trim()) {
                branchDiff = fallbackDiff;
                branchLabel = `${baseBranch} (last ${depth} commits, no upstream)`;
                break;
              }
            }
          }
        } else {
          const mergeBase = await getMergeBase(pi, baseBranch);
          if (mergeBase) {
            const { stdout, code } = await pi.exec("git", [
              "diff",
              mergeBase,
              "HEAD",
            ]);
            if (code === 0 && stdout.trim()) {
              branchDiff = stdout;
            }
          }
        }
      }

      // 3. Collect uncommitted changes (skip in commit mode — only review committed diffs)
      let stagedDiff = "";
      let unstagedDiff = "";
      let untrackedContent = "";
      let untrackedFiles: string[] = [];

      if (mode !== "commit") {
        const staged = await pi.exec("git", ["diff", "--staged"]);
        stagedDiff = staged.stdout;
        const unstaged = await pi.exec("git", ["diff"]);
        unstagedDiff = unstaged.stdout;
        const untracked = await pi.exec("git", [
          "ls-files",
          "--others",
          "--exclude-standard",
        ]);
        untrackedFiles = untracked.stdout
          .trim()
          .split("\n")
          .filter((f) => f.trim());
        for (const file of untrackedFiles) {
          try {
            const filePath = path.join(ctx.cwd, file.trim());
            // Skip symlinks to avoid leaking files outside the repo
            const stat = await fs.lstat(filePath);
            if (stat.isSymbolicLink()) {
              untrackedContent += `\n### ${file}\n(symlink — skipped)\n`;
              continue;
            }
            // Verify resolved path stays under cwd (canonicalize both to handle symlinked cwds)
            const resolved = await fs.realpath(filePath);
            const canonicalCwd = await fs.realpath(ctx.cwd);
            if (!resolved.startsWith(canonicalCwd + path.sep) && resolved !== canonicalCwd) {
              untrackedContent += `\n### ${file}\n(outside repo — skipped)\n`;
              continue;
            }
            const content = await fs.readFile(filePath, "utf8");
            untrackedContent += `\n### ${file}\n\`\`\`\n${content}\n\`\`\`\n`;
          } catch {
            untrackedContent += `\n### ${file}\n(could not read file)\n`;
          }
        }
      }

      // 4. Check if there's anything to review
      const hasBranchDiff = branchDiff.trim().length > 0;
      const hasCommitDiff = commitDiff.trim().length > 0;
      const hasStaged = stagedDiff.trim().length > 0;
      const hasUnstaged = unstagedDiff.trim().length > 0;
      const hasUntracked = untrackedFiles.length > 0;

      if (
        !hasBranchDiff &&
        !hasCommitDiff &&
        !hasStaged &&
        !hasUnstaged &&
        !hasUntracked
      ) {
        ctx.ui.notify("xreview: nothing to review", "info");
        await writeStatus("done");
        await ensureDir();
        await fs.writeFile(
          FINDINGS_PATH,
          "Verdict: correct\n\nNo changes found to review.",
          "utf8",
        );
        try {
          await sendToClaudePane(
            pi,
            config,
            "Verdict: correct\n\nNo changes found to review.",
          );
        } catch {}
        return;
      }

      // 5. Build review prompt with actual diff content
      const MAX_DIFF_CHARS = 50000;
      let totalChars = 0;
      let diffSections = "";

      if (hasCommitDiff) {
        const section = `## Committed changes (${branchLabel})\n\`\`\`diff\n${commitDiff}\n\`\`\`\n\n`;
        totalChars += section.length;
        diffSections += section;
      }

      if (hasBranchDiff) {
        const section = `## Committed branch changes (vs ${branchLabel})\n\`\`\`diff\n${branchDiff}\n\`\`\`\n\n`;
        totalChars += section.length;
        diffSections += section;
      }

      if (hasStaged) {
        const section = `## Staged changes\n\`\`\`diff\n${stagedDiff}\n\`\`\`\n\n`;
        totalChars += section.length;
        diffSections += section;
      }

      if (hasUnstaged) {
        const section = `## Unstaged changes\n\`\`\`diff\n${unstagedDiff}\n\`\`\`\n\n`;
        totalChars += section.length;
        diffSections += section;
      }

      if (hasUntracked) {
        const section = `## New untracked files\n${untrackedContent}\n\n`;
        totalChars += section.length;
        diffSections += section;
      }

      if (totalChars > MAX_DIFF_CHARS) {
        diffSections =
          diffSections.slice(0, MAX_DIFF_CHARS) +
          "\n\n... (diff truncated — use your tools to read full files if needed)\n";
      }

      const reviewPrompt =
        `Review the following code changes. All diff content is provided below — do NOT run git commands to discover changes.\n\n` +
        diffSections +
        `Provide prioritized, actionable findings based on the changes above.`;

      const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

      let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\n${reviewPrompt}`;
      if (projectGuidelines) {
        fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
      }

      xreviewActive = true;
      await writeStatus("reviewing");
      ctx.ui.setWidget("xreview", [
        ctx.ui.theme.fg("accent", "xreview: reviewing for Claude..."),
      ]);

      // Record message count before sending so agent_end can find the review response
      xreviewMessageCount = ctx.sessionManager.getEntries().length;
      pi.sendUserMessage(fullPrompt);
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!xreviewActive) return;

    // Only process if new messages were added since our review started
    // (the review user message + at least one assistant response)
    if (event.messages.length <= xreviewMessageCount) return;

    xreviewActive = false;

    ctx.ui.setWidget("xreview", undefined);

    const findings = extractAssistantText(event.messages);
    if (!findings) {
      await writeStatus("error");
      ctx.ui.notify("xreview: could not extract review findings", "error");
      return;
    }

    await ensureDir();
    await fs.writeFile(FINDINGS_PATH, findings, "utf8");
    await writeStatus("done");

    const config = await readConfig();
    if (!config) {
      ctx.ui.notify(
        "xreview: no config, findings saved to " + FINDINGS_PATH,
        "warning",
      );
      return;
    }

    try {
      await sendToClaudePane(pi, config, findings);
      ctx.ui.notify("xreview: findings sent to Claude", "info");
    } catch {
      ctx.ui.notify(
        `xreview: failed to send to Claude pane, findings at ${FINDINGS_PATH}`,
        "warning",
      );
    }
  });
}
