import * as vscode from "vscode";
import { getAutoVersionStatus } from "./autoVersion";
import { getRecentCommits } from "./git";
import { CommitEntry } from "./types";

type SidebarState =
  | { status: "loading" }
  | {
      status: "ready";
      commits: CommitEntry[];
      workspaceName: string;
      autoVersionEnabled: boolean;
      autoVersionDetail: string;
      autoVersionAction: "enableAutoVersion" | "disableAutoVersion";
    }
  | { status: "error"; message: string };

export class ChronicleSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeChronicle.sidebar";

  private currentView?: vscode.WebviewView;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.currentView = view;
    view.webview.options = {
      enableScripts: true
    };

    view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "refresh") {
        await this.refresh();
      }

      if (message.type === "generate") {
        await vscode.commands.executeCommand("codeChronicle.generateWorkspaceChangelog");
      }

      if (message.type === "copyLatest") {
        await vscode.commands.executeCommand("codeChronicle.copyLatestSummary");
      }

      if (message.type === "enableAutoVersion") {
        await vscode.commands.executeCommand("codeChronicle.enableAutoVersionBump");
      }

      if (message.type === "disableAutoVersion") {
        await vscode.commands.executeCommand("codeChronicle.disableAutoVersionBump");
      }
    });

    await this.refresh();
  }

  public async refresh(): Promise<void> {
    if (!this.currentView) {
      return;
    }

    this.currentView.webview.html = this.renderHtml({ status: "loading" });

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.currentView.webview.html = this.renderHtml({
        status: "error",
        message: "Open a Git-backed workspace to use Code Chronicle."
      });
      return;
    }

    try {
      const maxCommits = vscode.workspace
        .getConfiguration("codeChronicle", workspaceFolder)
        .get<number>("maxCommits", 12);

      const commits = await getRecentCommits(workspaceFolder, maxCommits);
      const autoVersionStatus = await getAutoVersionStatus(workspaceFolder);

      this.currentView.webview.html = this.renderHtml({
        status: "ready",
        commits,
        workspaceName: workspaceFolder.name,
        autoVersionEnabled: autoVersionStatus.enabled,
        autoVersionDetail: autoVersionStatus.supported
          ? `Auto version bump is ${autoVersionStatus.enabled ? "enabled" : "disabled"} (${autoVersionStatus.bumpType}).`
          : autoVersionStatus.reason ?? "Auto version bump is unavailable for this workspace.",
        autoVersionAction: autoVersionStatus.enabled ? "disableAutoVersion" : "enableAutoVersion"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Git error.";

      this.currentView.webview.html = this.renderHtml({
        status: "error",
        message: `Unable to load commit history. ${message}`
      });
    }
  }

  private renderHtml(state: SidebarState): string {
    const nonce = String(Date.now());

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-editor-background);
        --panel: color-mix(in srgb, var(--vscode-sideBar-background) 88%, #f59e0b 12%);
        --border: color-mix(in srgb, var(--vscode-sideBar-border, #444) 70%, #f59e0b 30%);
        --muted: var(--vscode-descriptionForeground);
        --accent: #f59e0b;
        --accent-soft: rgba(245, 158, 11, 0.15);
      }

      body {
        margin: 0;
        padding: 16px;
        background: radial-gradient(circle at top, rgba(245, 158, 11, 0.18), transparent 34%), var(--bg);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
      }

      .header {
        margin-bottom: 16px;
      }

      h1 {
        margin: 0;
        font-size: 18px;
      }

      .subtle {
        color: var(--muted);
        font-size: 12px;
        margin-top: 4px;
      }

      .actions {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin: 16px 0;
      }

      button {
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--vscode-button-foreground);
        padding: 10px 8px;
        border-radius: 12px;
        cursor: pointer;
      }

      .state {
        border: 1px dashed var(--border);
        border-radius: 14px;
        padding: 14px;
        background: var(--accent-soft);
        margin-bottom: 12px;
      }

      .commit {
        margin-bottom: 12px;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 12px;
        background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(245,158,11,0.08));
      }

      .subject {
        font-weight: 700;
        margin-bottom: 6px;
      }

      .meta {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 8px;
      }

      .stats {
        font-size: 12px;
        margin-bottom: 8px;
      }

      ul {
        padding-left: 18px;
        margin: 0;
      }

      li {
        margin-bottom: 4px;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    ${this.renderBody(state)}
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', () => {
          vscode.postMessage({ type: button.getAttribute('data-action') });
        });
      });
    </script>
  </body>
</html>`;
  }

  private renderBody(state: SidebarState): string {
    if (state.status === "loading") {
      return `
        <div class="header">
          <h1>Code Chronicle</h1>
          <div class="subtle">Loading recent history...</div>
        </div>
      `;
    }

    if (state.status === "error") {
      return `
        <div class="header">
          <h1>Code Chronicle</h1>
          <div class="subtle">Git-powered workspace memory inside VS Code</div>
        </div>
        <div class="actions">
          <button data-action="refresh">Refresh</button>
          <button data-action="generate">Generate</button>
          <button data-action="copyLatest">Copy</button>
          <button data-action="enableAutoVersion">Enable</button>
        </div>
        <div class="state">${state.message}</div>
      `;
    }

    const commitCards = state.commits
      .map((commit) => {
        const files = commit.files.length
          ? commit.files.slice(0, 6).map((file) => `<li>${escapeHtml(file.path)}</li>`).join("")
          : "<li>No changed files listed.</li>";

        return `
          <article class="commit">
            <div class="subject">${escapeHtml(commit.subject)}</div>
            <div class="meta">${escapeHtml(commit.shortHash)} - ${escapeHtml(commit.author)} - ${escapeHtml(commit.date)}</div>
            <div class="stats">${commit.stats.filesChanged} files changed, +${commit.stats.insertions} / -${commit.stats.deletions}</div>
            <ul>${files}</ul>
          </article>
        `;
      })
      .join("");

    return `
      <div class="header">
        <h1>${escapeHtml(state.workspaceName)}</h1>
        <div class="subtle">Recent history without leaving your editor</div>
      </div>
      <div class="state">${escapeHtml(state.autoVersionDetail)}</div>
      <div class="actions">
        <button data-action="refresh">Refresh</button>
        <button data-action="generate">Generate</button>
        <button data-action="copyLatest">Copy</button>
        <button data-action="${state.autoVersionAction}">${state.autoVersionEnabled ? "Disable" : "Enable"}</button>
      </div>
      ${commitCards || `<div class="state">No commits found yet.</div>`}
    `;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
