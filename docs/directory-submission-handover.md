# Handover: listing Quarterdeck in Anthropic's plugin directory

Written 11 Nov 2026 for a later Claude Code session to pick up. The aim is to submit both plugins to Anthropic's directory through the developer portal, using browser control (Claude in Chrome). Delete this file once both plugins are listed.

## Where things stand

- **v0.17.0 is published** (`main`, the `release` branch and tags are on GitHub).
- **The listing copy is committed on `main` but not released.** Both `plugin.json` files have `displayName` ("Quarterdeck", "Quarterdeck Guard"), a rewritten `description`, `author`, `homepage`, `repository` and `keywords`. `marketplace.json` has a description and the same plugin descriptions. Both plugin READMEs open with what Quarterdeck is, and the goals README has a "What it runs, stores and sends" section for the security scan.
- **Nothing has been done in the portal.** The one attempt at browser control failed with "Browser extension is not connected".
- `claude plugin validate` passes for both plugins and the marketplace, with one warning each: no icon.

## Which route

- Anthropic's official marketplace (`claude-plugins-official`) takes no open submissions; its docs say to ask an Anthropic partner contact.
- The open route is **Anthropic's directory**: people browse it on claude.ai and with `/plugin directory` in Claude Code. Submit at <https://claude.ai/directory/manage>.
- Docs, worth re-reading because the portal changes:
  - <https://claude.com/docs/plugins/submit.md>
  - <https://claude.com/docs/plugins/pre-submission-checklist.md>
  - <https://code.claude.com/docs/en/plugins/publish.md>

## Before opening the portal

1. **Icon.** Each plugin needs a square PNG, 512 to 2048 px, under 2 MB, at `plugins/<name>/.claude-plugin/icon.png`. The portal takes the icon only once, at the first save or submission, and later changes don't change the listing. Get the person's icon first; don't submit without one unless they say so.
2. **Fix the release script.** `scripts/release.mjs` builds on the local `release` branch. On 11 Nov that branch was a version behind the remote, so the push was rejected and needed a hand-made merge commit. Make it fetch and start from `origin/release`.
3. **Release 0.17.1** (`npm run release -- 0.17.1 --push`) so the `release` branch carries the listing copy and the icons. Check that `icon.png` ships: the script's copy filter leaves out only `tests`, `node_modules`, `tsconfig.json` and `.claude-plugin/types`.
4. **Ask the person which claude.ai account to submit from**, and check the browser is signed in to that one. Submitting needs a paid plan, and that account's GitHub connection must be able to push to `shannonbay/Quarterdeck`.
5. **Browser control.** The Claude in Chrome extension must be installed, running, and signed in to the same account as Claude Code. Chrome may need a restart after installing it.

## In the portal

Each plugin folder is its own submission. Do the guard first: the goals plugin depends on it.

| Field | quarterdeck-guard | quarterdeck-goals |
| --- | --- | --- |
| Type | Plugin bundle | Plugin bundle |
| Repository | `shannonbay/Quarterdeck` | `shannonbay/Quarterdeck` |
| Plugin path | `plugins/quarterdeck-guard` | `plugins/quarterdeck-goals` |
| Branch or tag | `release` | `release` |

The branch must be `release`: `main` doesn't hold the bundled server (`plugins/*/server/` is gitignored there).

Steps per plugin: Submit new → Plugin bundle → Source → **Validate** → Listing details → Data handling → Compliance → Review and submit.

**Stop and ask the person before each of these.** They are theirs to decide, and browser control must not do them on its own:

- Connecting GitHub to claude.ai, or installing the Claude GitHub App (an OAuth grant).
- The data handling answers. Suggested, for them to confirm:
  - Reads or stores personal data: it stores goals, memory and run history in a local SQLite file; a goal can read whatever the person's own connectors reach (their mail, say). Nothing leaves the computer through Quarterdeck.
  - Sends data to other services: no. Its one request reads its own `plugin.json` from GitHub to check for a newer version, and sends nothing about the person.
  - How long it keeps data: on the person's computer until they delete it.
  - Intended for under-18s: no.
- The contact email, and the four acknowledgements on the Compliance step.
- **Submit for review**, and later **Publish**.
- Setting up the GitHub push webhook (needs repo admin; optional, a scheduled check runs anyway).

## What to expect

- **Validate applies rules the CLI doesn't.** Fix anything marked Blocking in the repo, release again, and re-validate. A validation result covers one commit.
- **A reviewer hold is likely for quarterdeck-goals, and it isn't a rejection.** `server/quarterdeck-mcp.mjs` is about 833 KB against a 256 KiB per-file limit, and a Node server the validator can't read through is always held. The bundle is not minified; the README says where the source is. If a reviewer wants it smaller, the options are to split the bundle or minify less of the dependency code, neither started.
- **Name checks.** `quarterdeck-goals` and `quarterdeck-guard` are permanent once published. If the portal says a name is taken or too close to another listing, stop and ask; don't rename on your own. The plugin can't be plain `quarterdeck`: plugin tools are `mcp__<plugin>__*` and would clash with the server's `mcp__quarterdeck__*`.
- **Claude Code only.** Both plugins are mods (`modules` in `hooks/hooks.json`), which the directory lists for Claude Code. Chat ignores them.
- **The dependency.** A person who adds Quarterdeck from claude.ai gets it as `quarterdeck-goals@synced` and must turn on Quarterdeck Guard too, or no run starts (the pane says so). Once both are listed, say this in the goals README's Install section.
- **A first submission that fails the security scan is rejected**, and is resubmitted from its Review tab after a fix.
- Limit: 10 submissions per organisation in 24 hours, drafts and withdrawals included.

## After listing

- Add the directory as an install route in the main README and both plugin READMEs.
- Updates follow the `release` branch: each `npm run release` is picked up, scanned and published according to the plugin's publish setting. Keep raising `version` (the script does).
- Delete this file.
