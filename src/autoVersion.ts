import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getGitRoot } from "./git";

const execFileAsync = promisify(execFile);

export type BumpType = "patch" | "minor" | "major";
type VersionFieldKind = "versionName" | "versionCode";
type TargetKind = "packageJson" | "json" | "gradle";

interface VersionTargetSelection {
  kind: TargetKind;
  filePath: string;
  label: string;
  jsonPath?: string[];
  syncPackageLock?: boolean;
  pattern?: string;
  flags?: string;
  replacement?: string;
}

interface DetectedVersionTarget extends VersionTargetSelection {
  value: string | number;
}

interface JsonMutation {
  kind: "json";
  filePath: string;
  path: string[];
  before: string | number;
  after: string | number;
}

interface RegexMutation {
  kind: "regex";
  filePath: string;
  pattern: string;
  flags: string;
  replacement: string;
  before: string | number;
  after: string | number;
}

type AutoVersionMutation = JsonMutation | RegexMutation;

export interface AutoVersionEvent {
  id: string;
  repoRoot: string;
  field: VersionFieldKind;
  trigger: "commit" | "push";
  label: string;
  before: string;
  after: string;
  timestamp: string;
  undone?: boolean;
  stageFiles: string[];
  mutations: AutoVersionMutation[];
}

export interface AutoVersionStatus {
  enabled: boolean;
  supported: boolean;
  repoRoot?: string;
  reason?: string;
  bumpType: BumpType;
  versionCodeIncrement: number;
  versionNameTarget?: VersionTargetSelection;
  versionCodeTarget?: VersionTargetSelection;
  detail: string;
}

const hookBlockStart = "# >>> CODE CHRONICLE AUTO VERSION >>>";
const hookBlockEnd = "# <<< CODE CHRONICLE AUTO VERSION <<<";
const helperFileName = "code-chronicle-bump.cjs";
const eventFileName = "code-chronicle-event.json";
const valueToken = "__CODE_CHRONICLE_VALUE__";

function getConfig(workspaceFolder: vscode.WorkspaceFolder) {
  return vscode.workspace.getConfiguration("codeChronicle", workspaceFolder);
}

function getBumpType(workspaceFolder: vscode.WorkspaceFolder): BumpType {
  return getConfig(workspaceFolder).get<BumpType>("autoVersion.bumpType", "patch");
}

function getVersionCodeIncrement(workspaceFolder: vscode.WorkspaceFolder): number {
  return getConfig(workspaceFolder).get<number>("autoVersion.versionCodeIncrement", 1);
}

function getVersionNameTarget(workspaceFolder: vscode.WorkspaceFolder): VersionTargetSelection | undefined {
  return getConfig(workspaceFolder).get<VersionTargetSelection | null>("autoVersion.versionNameTarget") ?? undefined;
}

function getVersionCodeTarget(workspaceFolder: vscode.WorkspaceFolder): VersionTargetSelection | undefined {
  return getConfig(workspaceFolder).get<VersionTargetSelection | null>("autoVersion.versionCodeTarget") ?? undefined;
}

function getHooksDirectory(repoRoot: string): string {
  return path.join(repoRoot, ".git", "hooks");
}

function getHookPath(repoRoot: string, hookName: "pre-commit" | "pre-push"): string {
  return path.join(getHooksDirectory(repoRoot), hookName);
}

function getHelperScriptPath(repoRoot: string): string {
  return path.join(getHooksDirectory(repoRoot), helperFileName);
}

function getEventFilePath(repoRoot: string): string {
  return path.join(repoRoot, ".git", eventFileName);
}

function getHookBlock(helperScriptPath: string, trigger: "commit" | "push"): string {
  const normalizedHelperPath = helperScriptPath.replaceAll("\\", "/");

  return [
    hookBlockStart,
    `node "${normalizedHelperPath}" ${trigger}`,
    "status=$?",
    "if [ $status -ne 0 ]; then",
    "  exit $status",
    "fi",
    hookBlockEnd
  ].join("\n");
}

function describeTarget(target: VersionTargetSelection | undefined): string | undefined {
  if (!target) {
    return undefined;
  }

  return target.label;
}

function buildStatusDetail(status: {
  enabled: boolean;
  supported: boolean;
  reason?: string;
  versionNameTarget?: VersionTargetSelection;
  versionCodeTarget?: VersionTargetSelection;
  bumpType: BumpType;
  versionCodeIncrement: number;
}): string {
  if (!status.supported) {
    return status.reason ?? "Auto versioning is unavailable for this workspace.";
  }

  if (!status.enabled) {
    return "Auto versioning is disabled. Run setup to choose what should update on commit or push.";
  }

  const parts: string[] = [];

  if (status.versionNameTarget) {
    parts.push(
      `Version name updates on commit via ${describeTarget(status.versionNameTarget)} (${status.bumpType}).`
    );
  }

  if (status.versionCodeTarget) {
    parts.push(
      `Version code updates on push via ${describeTarget(status.versionCodeTarget)} (+${status.versionCodeIncrement}).`
    );
  }

  return parts.join(" ") || "Auto versioning is enabled.";
}

function getHelperScript(
  repoRoot: string,
  bumpType: BumpType,
  versionCodeIncrement: number,
  versionNameTarget: VersionTargetSelection | undefined,
  versionCodeTarget: VersionTargetSelection | undefined
): string {
  return `const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = ${JSON.stringify(repoRoot)};
const bumpType = ${JSON.stringify(bumpType)};
const versionCodeIncrement = ${JSON.stringify(versionCodeIncrement)};
const versionNameTarget = ${JSON.stringify(versionNameTarget ?? null)};
const versionCodeTarget = ${JSON.stringify(versionCodeTarget ?? null)};
const eventFilePath = ${JSON.stringify(getEventFilePath(repoRoot))};
const valueToken = ${JSON.stringify(valueToken)};

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

function setJsonPath(target, jsonPath, value) {
  let cursor = target;

  for (let index = 0; index < jsonPath.length - 1; index += 1) {
    const key = jsonPath[index];

    if (typeof cursor[key] !== "object" || cursor[key] === null) {
      cursor[key] = {};
    }

    cursor = cursor[key];
  }

  cursor[jsonPath[jsonPath.length - 1]] = value;
}

function getJsonPath(target, jsonPath) {
  let cursor = target;

  for (const key of jsonPath) {
    if (cursor == null || !(key in cursor)) {
      return undefined;
    }

    cursor = cursor[key];
  }

  return cursor;
}

function bumpVersion(version, type) {
  const [major, minor, patch] = String(version).split(".").map(Number);

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

function applyJsonVersionName(target) {
  const filePath = path.join(repoRoot, target.filePath);
  const document = readJson(filePath);
  const currentVersion = target.kind === "packageJson"
    ? document.version
    : getJsonPath(document, target.jsonPath);

  if (typeof currentVersion !== "string") {
    fail(\`Unable to find a version name in \${target.filePath}\`);
  }

  const nextVersion = bumpVersion(currentVersion, bumpType);
  const mutations = [];
  const stageFiles = [target.filePath];

  if (target.kind === "packageJson") {
    document.version = nextVersion;
    writeJson(filePath, document);
    mutations.push({
      kind: "json",
      filePath: target.filePath,
      path: ["version"],
      before: currentVersion,
      after: nextVersion
    });

    if (target.syncPackageLock) {
      const packageLockPath = path.join(repoRoot, "package-lock.json");

      if (fs.existsSync(packageLockPath)) {
        const packageLock = readJson(packageLockPath);
        const previousPackageLockVersion = packageLock.version;
        packageLock.version = nextVersion;
        mutations.push({
          kind: "json",
          filePath: "package-lock.json",
          path: ["version"],
          before: previousPackageLockVersion,
          after: nextVersion
        });

        if (packageLock.packages && packageLock.packages[""]) {
          mutations.push({
            kind: "json",
            filePath: "package-lock.json",
            path: ["packages", "", "version"],
            before: packageLock.packages[""].version,
            after: nextVersion
          });

          packageLock.packages[""].version = nextVersion;
        }

        writeJson(packageLockPath, packageLock);
        stageFiles.push("package-lock.json");
      }
    }
  } else {
    setJsonPath(document, target.jsonPath, nextVersion);
    writeJson(filePath, document);
    mutations.push({
      kind: "json",
      filePath: target.filePath,
      path: target.jsonPath,
      before: currentVersion,
      after: nextVersion
    });
  }

  return { before: currentVersion, after: nextVersion, mutations, stageFiles };
}

function applyJsonVersionCode(target) {
  const filePath = path.join(repoRoot, target.filePath);
  const document = readJson(filePath);
  const currentCode = getJsonPath(document, target.jsonPath);

  if (typeof currentCode !== "number") {
    fail(\`Unable to find a version code in \${target.filePath}\`);
  }

  const nextCode = currentCode + versionCodeIncrement;
  setJsonPath(document, target.jsonPath, nextCode);
  writeJson(filePath, document);

  return {
    before: String(currentCode),
    after: String(nextCode),
    mutations: [{
      kind: "json",
      filePath: target.filePath,
      path: target.jsonPath,
      before: currentCode,
      after: nextCode
    }],
    stageFiles: []
  };
}

function applyRegexTarget(target, nextValue) {
  const filePath = path.join(repoRoot, target.filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const regex = new RegExp(target.pattern, target.flags);
  const match = content.match(regex);

  if (!match) {
    fail(\`Unable to find a matching version field in \${target.filePath}\`);
  }

  const currentValue = match[2];
  const replacement = target.replacement.replace(valueToken, String(nextValue));
  const nextContent = content.replace(regex, replacement);
  fs.writeFileSync(filePath, nextContent, "utf8");

  return {
    before: currentValue,
    after: String(nextValue),
    mutations: [{
      kind: "regex",
      filePath: target.filePath,
      pattern: target.pattern,
      flags: target.flags,
      replacement: target.replacement,
      before: currentValue,
      after: String(nextValue)
    }],
    stageFiles: []
  };
}

function applyGradleVersionName(target) {
  const filePath = path.join(repoRoot, target.filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const regex = new RegExp(target.pattern, target.flags);
  const match = content.match(regex);

  if (!match) {
    fail(\`Unable to find a version name in \${target.filePath}\`);
  }

  const nextValue = bumpVersion(match[2], bumpType);
  return applyRegexTarget(target, nextValue);
}

function applyGradleVersionCode(target) {
  const filePath = path.join(repoRoot, target.filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const regex = new RegExp(target.pattern, target.flags);
  const match = content.match(regex);

  if (!match) {
    fail(\`Unable to find a version code in \${target.filePath}\`);
  }

  const nextValue = Number(match[2]) + versionCodeIncrement;

  if (Number.isNaN(nextValue)) {
    fail(\`Unsupported version code in \${target.filePath}\`);
  }

  return applyRegexTarget(target, nextValue);
}

function writeEvent(field, trigger, label, result) {
  const event = {
    id: \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,
    repoRoot,
    field,
    trigger,
    label,
    before: String(result.before),
    after: String(result.after),
    timestamp: new Date().toISOString(),
    stageFiles: result.stageFiles,
    mutations: result.mutations
  };

  fs.writeFileSync(eventFilePath, \`\${JSON.stringify(event, null, 2)}\\n\`, "utf8");
}

function stageFiles(files) {
  if (!files.length) {
    return;
  }

  const result = spawnSync("git", ["add", ...files], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    fail("unable to stage updated version files.");
  }
}

function run(trigger) {
  if (trigger === "commit" && versionNameTarget) {
    const result = versionNameTarget.kind === "gradle"
      ? applyGradleVersionName(versionNameTarget)
      : applyJsonVersionName(versionNameTarget);

    stageFiles(result.stageFiles);
    writeEvent("versionName", "commit", versionNameTarget.label, result);
    process.stdout.write(\`Code Chronicle updated version name to \${result.after}\\n\`);
    return;
  }

  if (trigger === "push" && versionCodeTarget) {
    const result = versionCodeTarget.kind === "gradle"
      ? applyGradleVersionCode(versionCodeTarget)
      : applyJsonVersionCode(versionCodeTarget);

    writeEvent("versionCode", "push", versionCodeTarget.label, result);
    process.stdout.write(\`Code Chronicle updated version code to \${result.after}\\n\`);
  }
}

run(process.argv[2]);
`;
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
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

async function updateWorkspaceSetting<T>(
  workspaceFolder: vscode.WorkspaceFolder,
  key: string,
  value: T
): Promise<void> {
  await getConfig(workspaceFolder).update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
}

async function readJsonFile(targetPath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(targetPath, "utf8")) as unknown;
}

async function detectPackageJsonTarget(repoRoot: string): Promise<DetectedVersionTarget | undefined> {
  const targetPath = path.join(repoRoot, "package.json");

  if (!(await pathExists(targetPath))) {
    return undefined;
  }

  const document = await readJsonFile(targetPath) as { version?: unknown };

  if (typeof document.version !== "string") {
    return undefined;
  }

  return {
    kind: "packageJson",
    filePath: "package.json",
    label: "package.json version",
    syncPackageLock: true,
    value: document.version
  };
}

async function detectJsonTargets(
  repoRoot: string,
  fileName: string
): Promise<{ versionName: DetectedVersionTarget[]; versionCode: DetectedVersionTarget[] }> {
  const filePath = path.join(repoRoot, fileName);

  if (!(await pathExists(filePath))) {
    return { versionName: [], versionCode: [] };
  }

  const document = await readJsonFile(filePath) as Record<string, unknown>;
  const versionNameTargets: DetectedVersionTarget[] = [];
  const versionCodeTargets: DetectedVersionTarget[] = [];

  const rootVersion = document.version;
  if (typeof rootVersion === "string") {
    versionNameTargets.push({
      kind: "json",
      filePath: fileName,
      label: `${fileName} version`,
      jsonPath: ["version"],
      value: rootVersion
    });
  }

  const expoSection = typeof document.expo === "object" && document.expo !== null
    ? document.expo as Record<string, unknown>
    : undefined;

  if (typeof expoSection?.version === "string") {
    versionNameTargets.push({
      kind: "json",
      filePath: fileName,
      label: `${fileName} expo.version`,
      jsonPath: ["expo", "version"],
      value: expoSection.version
    });
  }

  const androidSection = typeof document.android === "object" && document.android !== null
    ? document.android as Record<string, unknown>
    : undefined;

  if (typeof androidSection?.versionCode === "number") {
    versionCodeTargets.push({
      kind: "json",
      filePath: fileName,
      label: `${fileName} android.versionCode`,
      jsonPath: ["android", "versionCode"],
      value: androidSection.versionCode
    });
  }

  const expoAndroidSection = typeof expoSection?.android === "object" && expoSection.android !== null
    ? expoSection.android as Record<string, unknown>
    : undefined;

  if (typeof expoAndroidSection?.versionCode === "number") {
    versionCodeTargets.push({
      kind: "json",
      filePath: fileName,
      label: `${fileName} expo.android.versionCode`,
      jsonPath: ["expo", "android", "versionCode"],
      value: expoAndroidSection.versionCode
    });
  }

  return {
    versionName: versionNameTargets,
    versionCode: versionCodeTargets
  };
}

async function detectGradleTargets(
  repoRoot: string,
  fileName: string
): Promise<{ versionName: DetectedVersionTarget[]; versionCode: DetectedVersionTarget[] }> {
  const filePath = path.join(repoRoot, fileName);

  if (!(await pathExists(filePath))) {
    return { versionName: [], versionCode: [] };
  }

  const content = await fs.readFile(filePath, "utf8");
  const versionNamePattern = "(versionName\\s+[\"'])([^\"']+)([\"'])";
  const versionCodePattern = "(versionCode\\s*[= ]\\s*)(\\d+)";
  const versionNameMatch = content.match(new RegExp(versionNamePattern));
  const versionCodeMatch = content.match(new RegExp(versionCodePattern));

  return {
    versionName: versionNameMatch
      ? [{
          kind: "gradle",
          filePath: fileName,
          label: `${fileName} versionName`,
          pattern: versionNamePattern,
          flags: "",
          replacement: `$1${valueToken}$3`,
          value: versionNameMatch[2]
        }]
      : [],
    versionCode: versionCodeMatch
      ? [{
          kind: "gradle",
          filePath: fileName,
          label: `${fileName} versionCode`,
          pattern: versionCodePattern,
          flags: "",
          replacement: `$1${valueToken}`,
          value: Number(versionCodeMatch[2])
        }]
      : []
  };
}

async function detectTargets(repoRoot: string): Promise<{
  versionName: DetectedVersionTarget[];
  versionCode: DetectedVersionTarget[];
}> {
  const versionName: DetectedVersionTarget[] = [];
  const versionCode: DetectedVersionTarget[] = [];

  const packageJsonTarget = await detectPackageJsonTarget(repoRoot);
  if (packageJsonTarget) {
    versionName.push(packageJsonTarget);
  }

  for (const fileName of ["app.json", "app.config.json"]) {
    const detected = await detectJsonTargets(repoRoot, fileName);
    versionName.push(...detected.versionName);
    versionCode.push(...detected.versionCode);
  }

  for (const fileName of ["android/app/build.gradle", "android/app/build.gradle.kts", "build.gradle", "build.gradle.kts"]) {
    const detected = await detectGradleTargets(repoRoot, fileName);
    versionName.push(...detected.versionName);
    versionCode.push(...detected.versionCode);
  }

  return { versionName, versionCode };
}

async function promptForTarget(
  field: VersionFieldKind,
  candidates: DetectedVersionTarget[]
): Promise<VersionTargetSelection | undefined> {
  if (!candidates.length) {
    return undefined;
  }

  const items: Array<vscode.QuickPickItem & { target?: VersionTargetSelection }> = [
    ...candidates.map((candidate) => ({
      label: candidate.label,
      description: `${candidate.filePath} -> ${candidate.value}`,
      target: {
        kind: candidate.kind,
        filePath: candidate.filePath,
        label: candidate.label,
        jsonPath: candidate.jsonPath,
        syncPackageLock: candidate.syncPackageLock,
        pattern: candidate.pattern,
        flags: candidate.flags,
        replacement: candidate.replacement
      } satisfies VersionTargetSelection
    })),
    {
      label: `Skip ${field === "versionName" ? "version name" : "version code"} updates`,
      description: "Do not automate this field."
    }
  ];

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: field === "versionName"
      ? "Choose what should update on each commit"
      : "Choose what should update on each push",
    ignoreFocusOut: true
  });

  return selection?.target;
}

async function promptForVersionCodeIncrement(defaultValue: number): Promise<number> {
  const value = await vscode.window.showInputBox({
    title: "Code Chronicle",
    prompt: "How much should version code increase on each push?",
    value: String(defaultValue),
    ignoreFocusOut: true,
    validateInput: (input) => {
      const parsed = Number(input);
      return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a whole number greater than 0.";
    }
  });

  return value ? Number(value) : defaultValue;
}

async function promptForBumpType(defaultValue: BumpType): Promise<BumpType> {
  const selection = await vscode.window.showQuickPick(
    [
      { label: "Patch", description: "1.2.3 -> 1.2.4", value: "patch" },
      { label: "Minor", description: "1.2.3 -> 1.3.0", value: "minor" },
      { label: "Major", description: "1.2.3 -> 2.0.0", value: "major" }
    ],
    {
      placeHolder: "Choose how version name should bump on commit",
      ignoreFocusOut: true
    }
  );

  return (selection?.value as BumpType | undefined) ?? defaultValue;
}

async function upsertHook(
  repoRoot: string,
  hookName: "pre-commit" | "pre-push",
  block: string | undefined
): Promise<void> {
  const hookPath = getHookPath(repoRoot, hookName);
  const existingContent = (await pathExists(hookPath)) ? await fs.readFile(hookPath, "utf8") : "";
  const cleaned = removeManagedBlock(existingContent);

  if (!block) {
    if (!cleaned || cleaned === "#!/bin/sh") {
      await fs.rm(hookPath, { force: true });
      return;
    }

    await fs.writeFile(hookPath, `${cleaned}\n`, "utf8");
    await fs.chmod(hookPath, 0o755);
    return;
  }

  let nextContent = cleaned;
  if (!nextContent.trim()) {
    nextContent = "#!/bin/sh\n";
  }

  nextContent = `${nextContent.trimEnd()}\n\n${block}\n`;
  await fs.writeFile(hookPath, nextContent, "utf8");
  await fs.chmod(hookPath, 0o755);
}

async function writeHelperAndHooks(
  workspaceFolder: vscode.WorkspaceFolder,
  repoRoot: string,
  versionNameTarget: VersionTargetSelection | undefined,
  versionCodeTarget: VersionTargetSelection | undefined
): Promise<void> {
  const hooksDirectory = getHooksDirectory(repoRoot);
  const helperScriptPath = getHelperScriptPath(repoRoot);
  const bumpType = getBumpType(workspaceFolder);
  const versionCodeIncrement = getVersionCodeIncrement(workspaceFolder);

  await fs.mkdir(hooksDirectory, { recursive: true });

  if (!versionNameTarget && !versionCodeTarget) {
    await upsertHook(repoRoot, "pre-commit", undefined);
    await upsertHook(repoRoot, "pre-push", undefined);
    await fs.rm(helperScriptPath, { force: true });
    await fs.rm(getEventFilePath(repoRoot), { force: true });
    return;
  }

  await fs.writeFile(
    helperScriptPath,
    getHelperScript(repoRoot, bumpType, versionCodeIncrement, versionNameTarget, versionCodeTarget),
    "utf8"
  );
  await fs.chmod(helperScriptPath, 0o755);

  await upsertHook(
    repoRoot,
    "pre-commit",
    versionNameTarget ? getHookBlock(helperScriptPath, "commit") : undefined
  );
  await upsertHook(
    repoRoot,
    "pre-push",
    versionCodeTarget ? getHookBlock(helperScriptPath, "push") : undefined
  );
}

export async function getAutoVersionStatus(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<AutoVersionStatus> {
  const repoRoot = await getGitRoot(workspaceFolder);
  const detected = await detectTargets(repoRoot);
  const versionNameTarget = getVersionNameTarget(workspaceFolder);
  const versionCodeTarget = getVersionCodeTarget(workspaceFolder);
  const enabled = Boolean(versionNameTarget || versionCodeTarget);
  const supported = detected.versionName.length > 0 || detected.versionCode.length > 0;

  return {
    enabled,
    supported,
    repoRoot,
    reason: supported
      ? undefined
      : "No supported version fields were found. Supported targets: package.json, app.json/app.config.json, and Gradle versionName/versionCode.",
    bumpType: getBumpType(workspaceFolder),
    versionCodeIncrement: getVersionCodeIncrement(workspaceFolder),
    versionNameTarget,
    versionCodeTarget,
    detail: buildStatusDetail({
      enabled,
      supported,
      reason: supported
        ? undefined
        : "No supported version fields were found. Supported targets: package.json, app.json/app.config.json, and Gradle versionName/versionCode.",
      versionNameTarget,
      versionCodeTarget,
      bumpType: getBumpType(workspaceFolder),
      versionCodeIncrement: getVersionCodeIncrement(workspaceFolder)
    })
  };
}

export async function enableAutoVersionBump(workspaceFolder: vscode.WorkspaceFolder): Promise<AutoVersionStatus> {
  const repoRoot = await getGitRoot(workspaceFolder);
  const detected = await detectTargets(repoRoot);

  if (!detected.versionName.length && !detected.versionCode.length) {
    throw new Error(
      "No supported version fields were found. Supported targets: package.json, app.json/app.config.json, and Gradle versionName/versionCode."
    );
  }

  const versionNameTarget = await promptForTarget("versionName", detected.versionName);
  const versionCodeTarget = await promptForTarget("versionCode", detected.versionCode);

  const bumpType = versionNameTarget
    ? await promptForBumpType(getBumpType(workspaceFolder))
    : getBumpType(workspaceFolder);
  const versionCodeIncrement = versionCodeTarget
    ? await promptForVersionCodeIncrement(getVersionCodeIncrement(workspaceFolder))
    : getVersionCodeIncrement(workspaceFolder);

  await updateWorkspaceSetting(workspaceFolder, "autoVersion.bumpType", bumpType);
  await updateWorkspaceSetting(workspaceFolder, "autoVersion.versionCodeIncrement", versionCodeIncrement);
  await updateWorkspaceSetting(workspaceFolder, "autoVersion.versionNameTarget", versionNameTarget ?? null);
  await updateWorkspaceSetting(workspaceFolder, "autoVersion.versionCodeTarget", versionCodeTarget ?? null);
  await updateWorkspaceSetting(
    workspaceFolder,
    "autoVersion.enabled",
    Boolean(versionNameTarget || versionCodeTarget)
  );

  await writeHelperAndHooks(workspaceFolder, repoRoot, versionNameTarget, versionCodeTarget);
  return getAutoVersionStatus(workspaceFolder);
}

export async function disableAutoVersionBump(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const repoRoot = await getGitRoot(workspaceFolder);
  const helperScriptPath = getHelperScriptPath(repoRoot);

  await upsertHook(repoRoot, "pre-commit", undefined);
  await upsertHook(repoRoot, "pre-push", undefined);
  await fs.rm(helperScriptPath, { force: true });
  await fs.rm(getEventFilePath(repoRoot), { force: true });
  await updateWorkspaceSetting(workspaceFolder, "autoVersion.enabled", false);
  await updateWorkspaceSetting(workspaceFolder, "autoVersion.versionNameTarget", null);
  await updateWorkspaceSetting(workspaceFolder, "autoVersion.versionCodeTarget", null);
}

export async function readAutoVersionEvent(workspaceFolder: vscode.WorkspaceFolder): Promise<AutoVersionEvent | undefined> {
  const repoRoot = await getGitRoot(workspaceFolder);
  const eventPath = getEventFilePath(repoRoot);

  if (!(await pathExists(eventPath))) {
    return undefined;
  }

  return JSON.parse(await fs.readFile(eventPath, "utf8")) as AutoVersionEvent;
}

function applyJsonPath(target: Record<string, unknown>, jsonPath: string[], value: string | number): void {
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < jsonPath.length - 1; index += 1) {
    const key = jsonPath[index];
    const nextValue = cursor[key];

    if (typeof nextValue !== "object" || nextValue === null) {
      cursor[key] = {};
    }

    cursor = cursor[key] as Record<string, unknown>;
  }

  cursor[jsonPath[jsonPath.length - 1]] = value;
}

async function revertMutation(repoRoot: string, mutation: AutoVersionMutation): Promise<void> {
  const targetPath = path.join(repoRoot, mutation.filePath);

  if (mutation.kind === "json") {
    const document = await readJsonFile(targetPath) as Record<string, unknown>;
    applyJsonPath(document, mutation.path, mutation.before);
    await fs.writeFile(targetPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return;
  }

  const content = await fs.readFile(targetPath, "utf8");
  const nextContent = content.replace(
    new RegExp(mutation.pattern, mutation.flags),
    mutation.replacement.replace(valueToken, String(mutation.before))
  );

  await fs.writeFile(targetPath, nextContent, "utf8");
}

export async function undoLatestAutoVersionUpdate(workspaceFolder: vscode.WorkspaceFolder): Promise<AutoVersionEvent> {
  const event = await readAutoVersionEvent(workspaceFolder);

  if (!event) {
    throw new Error("There is no recent version update to undo.");
  }

  if (event.undone) {
    throw new Error("The latest version update has already been undone.");
  }

  for (const mutation of event.mutations) {
    await revertMutation(event.repoRoot, mutation);
  }

  if (event.stageFiles.length) {
    await runGit(["add", ...event.stageFiles], event.repoRoot);
  }

  const nextEvent: AutoVersionEvent = {
    ...event,
    undone: true
  };

  await fs.writeFile(getEventFilePath(event.repoRoot), `${JSON.stringify(nextEvent, null, 2)}\n`, "utf8");
  return nextEvent;
}

export async function watchAutoVersionEvents(
  workspaceFolder: vscode.WorkspaceFolder,
  onEvent: (event: AutoVersionEvent) => Promise<void> | void
): Promise<vscode.Disposable> {
  const repoRoot = await getGitRoot(workspaceFolder);
  const eventPath = getEventFilePath(repoRoot);
  let lastSeenId = (await readAutoVersionEvent(workspaceFolder))?.id;

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(repoRoot, ".git/code-chronicle-event.json")
  );

  const handleEventFileChange = async (): Promise<void> => {
    const event = await readAutoVersionEvent(workspaceFolder);

    if (!event || event.undone || event.id === lastSeenId) {
      return;
    }

    lastSeenId = event.id;
    await onEvent(event);
  };

  return vscode.Disposable.from(
    watcher,
    watcher.onDidCreate(() => {
      void handleEventFileChange();
    }),
    watcher.onDidChange(() => {
      void handleEventFileChange();
    }),
    watcher.onDidDelete(() => {
      if (eventPath) {
        lastSeenId = undefined;
      }
    })
  );
}
