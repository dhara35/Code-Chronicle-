import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CommitEntry, CommitStats } from "./types";

const execFileAsync = promisify(execFile);
const recordSeparator = "\u001e";
const fieldSeparator = "\u001f";

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 4
  });

  return stdout.trim();
}

export async function getGitRoot(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
  return runGit(["rev-parse", "--show-toplevel"], workspaceFolder.uri.fsPath);
}

function parseShortStat(output: string): CommitStats {
  const stats: CommitStats = {
    filesChanged: 0,
    insertions: 0,
    deletions: 0
  };

  const filesChangedMatch = output.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = output.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = output.match(/(\d+)\s+deletions?\(-\)/);

  if (filesChangedMatch) {
    stats.filesChanged = Number(filesChangedMatch[1]);
  }

  if (insertionsMatch) {
    stats.insertions = Number(insertionsMatch[1]);
  }

  if (deletionsMatch) {
    stats.deletions = Number(deletionsMatch[1]);
  }

  return stats;
}

export async function ensureGitWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  await getGitRoot(workspaceFolder);
}

export async function getRecentCommits(
  workspaceFolder: vscode.WorkspaceFolder,
  maxCommits: number
): Promise<CommitEntry[]> {
  const cwd = workspaceFolder.uri.fsPath;
  const commitListOutput = await runGit(
    [
      "log",
      `--max-count=${maxCommits}`,
      "--date=short",
      `--pretty=format:%H${fieldSeparator}%an${fieldSeparator}%ad${fieldSeparator}%s${recordSeparator}`
    ],
    cwd
  );

  const rawCommits = commitListOutput
    .split(recordSeparator)
    .map((record) => record.trim())
    .filter(Boolean);

  const commits = await Promise.all(
    rawCommits.map(async (record) => {
      const [hash, author, date, subject] = record.split(fieldSeparator);
      const nameOnlyOutput = await runGit(["show", "--format=", "--name-only", hash], cwd);
      const shortStatOutput = await runGit(["show", "--format=", "--shortstat", hash], cwd);

      return {
        hash,
        shortHash: hash.slice(0, 7),
        author,
        date,
        subject,
        files: nameOnlyOutput
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((path) => ({ path })),
        stats: parseShortStat(shortStatOutput)
      } satisfies CommitEntry;
    })
  );

  return commits;
}
