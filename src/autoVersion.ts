import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getGitRoot } from "./git";

export type BumpType = "patch" | "minor" | "major";

export interface AutoVersionStatus {
  enabled: boolean;
  supported: boolean;
  repoRoot?: string;
  reason?: string;
  bumpType: BumpType;
}

const hookBlockStart = "# >>> CODE CHRONICLE AUTO VERSION >>>";
const hookBlockEnd = "# <<< CODE CHRONICLE AUTO VERSION <<<";
const helperFileName = "code-chronicle-bump.cjs";

function getConfig(workspaceFolder: vscode.WorkspaceFolder) {
  return vscode.workspace.getConfiguration("codeChronicle", workspaceFolder);
}

function getBumpType(workspaceFolder: vscode.WorkspaceFolder): BumpType {
  return getConfig(workspaceFolder).get<BumpType>("autoVersion.bumpType", "patch");
}

function getHooksDirectory(repoRoot: string): string {
  return path.join(repoRoot, ".git", "hooks");
}

function getPreCommitHookPath(repoRoot: string): string {
  return path.join(getHooksDirectory(repoRoot), "pre-commit");
}

function getHelperScriptPath(repoRoot: string): string {
  return path.join(getHooksDirectory(repoRoot), helperFileName);
}

function getHookBlock(helperScriptPath: string): string {
  const normalizedHelperPath = helperScriptPath.replaceAll("\\", "/");

  return [
    hookBlockStart,
    `node "${normalizedHelperPath}"`,
    "status=$?",
    "if [ $status -ne 0 ]; then",
    "  exit $status",
    "fi",
    hookBlockEnd
  ].join("\n");
}

function getHelperScript(repoRoot: string, bumpType: BumpType): string {
  return `const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = ${JSON.stringify(repoRoot)};
const bumpType = ${JSON.stringify(bumpType)};

function fail(message) {
  process.stderr.write(\`Code Chronicle: \${message}\\n\`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, \`\${JSON.stringify(value, null, 2)}\\n\`, "utf8");
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);

  if ([major, minor, patch].some(Number.isNaN)) {
    fail(\`Unsupported semver version: \${version}\`);
  }

  if (type === "major") {
    return \`\${major + 1}.0.0\`;
  }

  if (type === "minor") {
    return \`\${major}.\${minor + 1}.0\`;
  }

  return \`\${major}.\${minor}.\${patch + 1}\`;
}

const packageJsonPath = path.join(repoRoot, "package.json");
if (!fs.existsSync(packageJsonPath)) {
  fail("package.json not found. Auto version bump supports Node-style repos only.");
}

const packageJson = readJson(packageJsonPath);
const nextVersion = bumpVersion(packageJson.version, bumpType);
packageJson.version = nextVersion;
writeJson(packageJsonPath, packageJson);

const packageLockPath = path.join(repoRoot, "package-lock.json");
if (fs.existsSync(packageLockPath)) {
  const packageLock = readJson(packageLockPath);
  packageLock.version = nextVersion;

  if (packageLock.packages && packageLock.packages[""]) {
    packageLock.packages[""].version = nextVersion;
  }

  writeJson(packageLockPath, packageLock);
}

const filesToAdd = ["package.json"];
if (fs.existsSync(packageLockPath)) {
  filesToAdd.push("package-lock.json");
}

const result = spawnSync("git", ["add", ...filesToAdd], {
  cwd: repoRoot,
  stdio: "inherit"
});

if (result.status !== 0) {
  fail("unable to stage bumped version files.");
}

process.stdout.write(\`Code Chronicle bumped version to \${nextVersion}\\n\`);
`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function removeManagedBlock(content: string): string {
  const escapedStart = hookBlockStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = hookBlockEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g");

  return content.replace(blockPattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

async function updateEnabledSetting(workspaceFolder: vscode.WorkspaceFolder, enabled: boolean): Promise<void> {
  await getConfig(workspaceFolder).update("autoVersion.enabled", enabled, vscode.ConfigurationTarget.WorkspaceFolder);
}

export async function getAutoVersionStatus(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<AutoVersionStatus> {
  const repoRoot = await getGitRoot(workspaceFolder);
  const packageJsonPath = path.join(repoRoot, "package.json");
  const preCommitPath = getPreCommitHookPath(repoRoot);
  const bumpType = getBumpType(workspaceFolder);

  if (!(await pathExists(packageJsonPath))) {
    return {
      enabled: false,
      supported: false,
      repoRoot,
      reason: "package.json not found. Auto version bump currently supports Node-style repos only.",
      bumpType
    };
  }

  const preCommitExists = await pathExists(preCommitPath);
  if (!preCommitExists) {
    return {
      enabled: false,
      supported: true,
      repoRoot,
      bumpType
    };
  }

  const preCommitContent = await fs.readFile(preCommitPath, "utf8");

  return {
    enabled: preCommitContent.includes(hookBlockStart),
    supported: true,
    repoRoot,
    bumpType
  };
}

export async function enableAutoVersionBump(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const status = await getAutoVersionStatus(workspaceFolder);

  if (!status.repoRoot) {
    throw new Error("Unable to find the Git repository for this workspace.");
  }

  if (!status.supported) {
    throw new Error(status.reason ?? "Auto version bump is not supported in this workspace.");
  }

  const hooksDirectory = getHooksDirectory(status.repoRoot);
  const preCommitPath = getPreCommitHookPath(status.repoRoot);
  const helperScriptPath = getHelperScriptPath(status.repoRoot);
  const hookBlock = getHookBlock(helperScriptPath);

  await fs.mkdir(hooksDirectory, { recursive: true });
  await fs.writeFile(helperScriptPath, getHelperScript(status.repoRoot, status.bumpType), "utf8");
  await fs.chmod(helperScriptPath, 0o755);

  const existingContent = (await pathExists(preCommitPath)) ? await fs.readFile(preCommitPath, "utf8") : "";
  let nextContent = existingContent;

  if (!existingContent.trim()) {
    nextContent = "#!/bin/sh\n\n";
  }

  if (!nextContent.includes(hookBlockStart)) {
    nextContent = `${nextContent.trimEnd()}\n\n${hookBlock}\n`;
  }

  await fs.writeFile(preCommitPath, nextContent, "utf8");
  await fs.chmod(preCommitPath, 0o755);
  await updateEnabledSetting(workspaceFolder, true);
}

export async function disableAutoVersionBump(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const status = await getAutoVersionStatus(workspaceFolder);

  if (!status.repoRoot) {
    throw new Error("Unable to find the Git repository for this workspace.");
  }

  const preCommitPath = getPreCommitHookPath(status.repoRoot);
  const helperScriptPath = getHelperScriptPath(status.repoRoot);

  if (await pathExists(preCommitPath)) {
    const existingContent = await fs.readFile(preCommitPath, "utf8");
    const nextContent = removeManagedBlock(existingContent);

    if (!nextContent || nextContent === "#!/bin/sh") {
      await fs.rm(preCommitPath, { force: true });
    } else {
      await fs.writeFile(preCommitPath, `${nextContent}\n`, "utf8");
    }
  }

  await fs.rm(helperScriptPath, { force: true });
  await updateEnabledSetting(workspaceFolder, false);
}
