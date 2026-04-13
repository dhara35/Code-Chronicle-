import * as vscode from "vscode";
import { disableAutoVersionBump, enableAutoVersionBump } from "./autoVersion";
import { buildLatestCommitSummary, generateWorkspaceChangelog } from "./changelogService";
import { ensureGitWorkspace, getRecentCommits } from "./git";
import { ChronicleSidebarProvider } from "./sidebarProvider";

async function getWorkspaceFolder(): Promise<vscode.WorkspaceFolder> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    throw new Error("Open a workspace folder first.");
  }

  await ensureGitWorkspace(workspaceFolder);
  return workspaceFolder;
}

export function activate(context: vscode.ExtensionContext): void {
  const sidebarProvider = new ChronicleSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChronicleSidebarProvider.viewType, sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeChronicle.refresh", async () => {
      await sidebarProvider.refresh();
      vscode.window.showInformationMessage("Code Chronicle refreshed.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeChronicle.generateWorkspaceChangelog", async () => {
      try {
        const workspaceFolder = await getWorkspaceFolder();
        const targetPath = await generateWorkspaceChangelog(workspaceFolder);
        const document = await vscode.workspace.openTextDocument(targetPath);
        await vscode.window.showTextDocument(document, { preview: false });
        await sidebarProvider.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to generate changelog.";
        vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeChronicle.copyLatestSummary", async () => {
      try {
        const workspaceFolder = await getWorkspaceFolder();
        const commits = await getRecentCommits(workspaceFolder, 1);

        if (!commits.length) {
          vscode.window.showWarningMessage("No commits found yet.");
          return;
        }

        await vscode.env.clipboard.writeText(buildLatestCommitSummary(commits[0]));
        vscode.window.showInformationMessage("Latest commit summary copied to the clipboard.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to copy commit summary.";
        vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeChronicle.enableAutoVersionBump", async () => {
      try {
        const workspaceFolder = await getWorkspaceFolder();
        await enableAutoVersionBump(workspaceFolder);
        await sidebarProvider.refresh();
        vscode.window.showInformationMessage("Auto version bump enabled for this repository.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to enable auto version bump.";
        vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeChronicle.disableAutoVersionBump", async () => {
      try {
        const workspaceFolder = await getWorkspaceFolder();
        await disableAutoVersionBump(workspaceFolder);
        await sidebarProvider.refresh();
        vscode.window.showInformationMessage("Auto version bump disabled for this repository.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to disable auto version bump.";
        vscode.window.showErrorMessage(message);
      }
    })
  );
}

export function deactivate(): void {
  // No-op: the extension does not hold long-running resources.
}
