# Handover: listing Quarterdeck in Anthropic's plugin directory

Written 11 Nov 2026 for a later Claude Code session to pick up. The aim is to submit both plugins to Anthropic's directory through the developer portal, using browser control (Claude in Chrome). Delete this file once both plugins are listed.

## Where things stand

- **v0.18.0 is published** (`main`, the `release` branch and tags are on GitHub). Submit from this release.
- **The listing copy and icons are released** in 0.18.0. Both `plugin.json` files have `displayName` ("Quarterdeck", "Quarterdeck Guard"), a rewritten `description`, `author`, `homepage`, `repository` and `keywords`. `marketplace.json` has a description and the same plugin descriptions. Both plugin READMEs open with what Quarterdeck is, and the goals README has a "What it runs, stores and sends" section for the security scan.
- **Nothing has been done in the portal.** The one attempt at browser control failed with "Browser extension is not connected".
- `claude plugin validate --strict` passes for both plugins.

## Which route

- Anthropic's official marketplace (`claude-plugins-official`) takes no open submissions; its docs say to ask an Anthropic partner contact.
- The open route is **Anthropic's directory**: people browse it on claude.ai and with `/plugin directory` in Claude Code. Submit at <https://claude.ai/directory/manage>.
- Docs, worth re-reading because the portal changes:
  - <https://claude.com/docs/plugins/submit.md>
  - <https://claude.com/docs/plugins/pre-submission-checklist.md>
  - <https://code.claude.com/docs/en/plugins/publish.md>

## Present it as one product

Promote only **quarterdeck-goals** ("Quarterdeck"). The guard is a separate plugin only because Claude Code never shows a plugin's hooks the calls caused by its own timers, so the goals plugin can't check its own timer-started runs (see the guard README, "Why it is a separate plugin"). It can't be merged, but users shouldn't have to think about it.

- **The guard still has to be submitted.** The goals plugin depends on it, and the claude.ai route doesn't add it automatically (see "The dependency" below).
- **Write the guard's listing as a part of Quarterdeck, not a product of its own.** Done in `plugin.json` and `marketplace.json`: its description opens "Part of Quarterdeck: install Quarterdeck (quarterdeck-goals), not this on its own." Use the same opening in the portal, and give it no screenshots or promotion beyond what's required.
- **Turn the guard into a selling point on the goals listing.** Add one line along the lines of "Includes Quarterdeck Guard, which holds each background run to the autonomy you set."
- **Possible rename, for the person to decide before the first submission.** Names are permanent once published. A name like `quarterdeck-goals-guard` would read as a component. Renaming the guard is safe: it finds the runner by the name `quarterdeck-goals`, which stays. Renaming would need the folder, `plugin.json`, the goals plugin's dependency entry, `marketplace.json`, the doctor and the READMEs changed, then a release. Ask; don't rename on your own.

## Before opening the portal

1. **Icon: done.** Both plugins have the approved icon at `.claude-plugin/icon.png` (1024 px, rendered from `docs/quarterdeck-icon.svg` with sharp). The portal takes the icon only once, at the first save or submission, so check it shows in Listing details before saving anything.
2. **Release script: done.** `scripts/release.mjs` now fetches and builds on `origin/release`.
3. **Release: done (0.18.0).** It carries the listing copy and the icons (`icon.png` checked on the `release` branch in both plugins).
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
