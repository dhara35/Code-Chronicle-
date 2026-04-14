<p align="center">
  <img src="./media/chronicle.svg" alt="Code Chronicle icon" width="72" height="72" />
</p>

<h1 align="center">Code Chronicle</h1>

<p align="center">
  Keep recent Git history, changelog generation, and version updates close to your editor.
</p>

Code Chronicle is a VS Code extension for developers who want quick Git context without bouncing back to the terminal all day. It gives you a compact history view, a fast way to copy the latest commit summary, changelog generation from recent commits, and configurable version automation for repos that need it.

## Highlights

- Browse recent commits in a dedicated sidebar.
- Generate a markdown changelog from recent Git history.
- Copy the latest commit summary for standups, PRs, or release notes.
- Configure version name updates on commit and version code updates on push.
- Undo the latest automated version update from a lightweight VS Code toast.

## Features

### Workspace history in the sidebar

The Code Chronicle sidebar keeps the latest commits visible inside VS Code, including:

- commit subject
- author and date
- file change stats
- touched files
- current auto-versioning status

### Changelog generation

Run `Code Chronicle: Generate Workspace Changelog` to create or refresh `WORKSPACE_CHANGELOG.md` from recent commits in the current workspace.

### Latest commit summary

Run `Code Chronicle: Copy Latest Commit Summary` to copy a compact summary of the newest commit to your clipboard.

### Auto versioning with setup choices

Run `Code Chronicle: Set Up Auto Versioning` and the extension will ask what should be automated for the current repo.

You can choose:

- version name updates on every commit
- version code updates on every push
- both
- or just one of them

Supported targets currently include:

- `package.json` version
- `app.json` or `app.config.json` version fields
- Android version code fields in supported JSON configs
- Gradle `versionName`
- Gradle `versionCode`

When an automated update happens, Code Chronicle shows a small notification with an `Undo` action.

## Commands

- `Code Chronicle: Refresh`
- `Code Chronicle: Generate Workspace Changelog`
- `Code Chronicle: Copy Latest Commit Summary`
- `Code Chronicle: Set Up Auto Versioning`
- `Code Chronicle: Disable Auto Version Bump`
- `Code Chronicle: Undo Latest Version Update`

## Configuration

### `codeChronicle.maxCommits`

Number of recent commits shown in the sidebar.

Default: `12`

### `codeChronicle.changelogFile`

Name of the generated changelog file.

Default: `WORKSPACE_CHANGELOG.md`

### `codeChronicle.autoVersion.bumpType`

Semver segment used when version name is bumped on commit.

Default: `patch`

### `codeChronicle.autoVersion.versionCodeIncrement`

Amount added to version code on each push.

Default: `1`

## Development

### Prerequisites

- Node.js 20+
- npm
- Git
- VS Code

### Run locally

```bash
npm install
npm run compile
```

Open the project in VS Code and press `F5` to launch an Extension Development Host.

### Useful scripts

```bash
npm run compile
npm run watch
npm run lint
```

## Project structure

```text
src/
  extension.ts
  git.ts
  autoVersion.ts
  changelogService.ts
  sidebarProvider.ts
  types.ts
media/
  chronicle.svg
```

## Notes on version automation

Code Chronicle installs repo-local Git hooks for the current workspace when auto versioning is enabled.

- Commit hooks are used for version name updates.
- Push hooks are used for version code updates.
- Push-time version code changes update the working tree for the next commit rather than altering commits that were already pushed.

## Design choices

The extension currently talks to Git through the Git CLI instead of the built-in VS Code Git API. That keeps the behavior predictable, easy to debug, and portable across the repo-level workflows this extension depends on.

Code Chronicle also stays intentionally focused on practical Git context and lightweight repo automation. There is plenty of room for AI-assisted summaries later, but the current feature set works immediately from source with no external services or API keys.

Version automation starts with common version fields such as `package.json`, supported app config files, and Gradle metadata. That narrower scope helps keep setup simple and the behavior easy to trust before expanding into more custom file formats.

## Roadmap

Planned improvements that would fit the direction of the project well:

- diff-level summaries for individual commits
- timeline filters by file or author
- optional AI summaries for groups of commits
- support for more custom version file formats
- deeper integration with the Source Control view

## License

MIT
