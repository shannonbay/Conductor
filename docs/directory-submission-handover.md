# Handover: listing Quarterdeck in Anthropic's plugin directory

Last updated 12 Nov 2026. Read this and `CLAUDE.md` before picking up any item of the to-do list **"Marketplace publication sprint"** (Goals pane, or the `todos` tool). Each item there is one fresh session. Delete this file once both plugins are listed (item 12).

## Where things stand

- **Branch:** all work is on `directory-validate` (pushed). `main` and `release` are untouched since v0.18.0. Item 9 merges it.
- **`directory-validate-built`** (pushed) is a throwaway: a copy of the branch with the goals hooks bundled, made only so the portal could validate it. Delete it in item 12. Don't build on it.
- **Portal:** nothing submitted. Validating saves a draft "in this tab", so a draft may exist under Submissions in <https://claude.ai/directory/manage>; open it rather than starting a second submission for the same repo and folder. GitHub is **not** connected to claude.ai yet ("GitHub isn't connected for this Claude organization").
- **Validation status:** both plugins pass the portal's Validate with **no blocking findings** (guard on `directory-validate`, goals on `directory-validate-built`). What remains are reviewer holds (below), which don't stop submission.
- Done so far (sprint items 1 to 5): hooks bundled into one file at release; `run_scope` fix live-tested; standing session installs in auto mode with Quarterdeck's own tools allowed; permission prompts tested on phone and pane; allow rules shown in the pane.

## Decisions already made by Shannon

- **Account:** submit from the claude.ai account Chrome is signed in to ("Shannon", Pro plan).
- **Names stay** `quarterdeck-goals` and `quarterdeck-guard` (permanent once published). No rename.
- **Data handling answers** (use for both plugins, fitted to the portal's options; show Shannon anything that doesn't map cleanly):
  - Reads or stores personal data: stores goals, memory and run history in a local SQLite file; a goal can read whatever the person's own connectors reach (their mail, say). Nothing leaves the computer through Quarterdeck.
  - Sends data to other services: no. Its one request reads its own `plugin.json` from GitHub to check for a newer version, and sends nothing about the person.
  - How long it keeps data: on the person's computer until they delete it.
  - Intended for under-18s: no.
- **Quarterdeck sits under Claude Code's own permission rules.** The guard only refuses or passes a call on; it never allows (the directory blocks a mod that answers "allow"). Shannon agreed this is right for the product.
- **Standing session:** installs with `--permission-mode auto` by default and starts with `--allowedTools` for Quarterdeck's own server. Agreed.

## Still Shannon's to do or decide (ask; never do these yourself)

- Connecting GitHub to claude.ai, or installing the Claude GitHub App (an OAuth grant).
- The contact email and the four acknowledgements on the Compliance step.
- **Submit for review**, and later **Publish**.
- Setting up the GitHub push webhook (needs repo admin; optional, a scheduled check runs anyway).
- Contacting Anthropic (item 11).

## What the tests showed (for the READMEs, item 6)

All on Windows, Nov 2026, with the guard that never allows:

| Where the run starts | Mode | Result |
| --- | --- | --- |
| A Claude Code window | default | Quarterdeck's own tools ran unasked; each other tool call prompted in the window ("from the quarterdeck-goals plugin", Yes/No only) and waited |
| A Claude Code window | auto | Everything ran, no prompts |
| Standing session | auto | Everything ran, no prompts |
| Standing session | manual | Every call prompted (before `--allowedTools`, Quarterdeck's own too). Prompts reach the Claude app on the phone ("Allow Claude to run? … Allow once / Deny", no goal named) and claude.ai/code (titled "Goal: <name> (<run id>)", with a countdown). Unanswered, the run timed out at 15 min |
| Standing session | dontAsk | Without `--allowedTools`, even `get_goal_brief` was refused and the run failed in 13 s; with it, the run completed |

- In auto mode the classifier reviews a call **before** the guard's hook and refuses one whose input changes afterwards. That is why run agents now pass `run_scope` themselves and the guard leaves a call that already carries it unchanged.
- The Goals pane shows nothing while a run waits on a prompt ("run running · Starting: reading the brief"). That's item 13.
- Claude Code offers "Yes, and don't ask again" only when the prompt can show everything the rule would allow; otherwise only a one-time approval. Hence item 5's allow rules.
- A `.claude/settings.json` in the standing session's folder (`~/.quarterdeck/runner`) made it come up but never tick. Don't put one there.

## Reviewer holds and other findings (items 7 and 8)

To see them again with full text: in the portal, Submit new → Plugin bundle → Repository `https://github.com/shannonbay/Quarterdeck/tree/<branch>/plugins/<plugin>` → Validate, then expand each row. Line numbers refer to the bundled `hooks/register.jsx` for goals.

**quarterdeck-goals** (each hold asks for a README line):
- Mod calls tools itself, without the model asking: say which tools and when.
- Mod can fetch from the network and run commands or tools: say what it fetches and what it runs, and what its hooks do with the calls they see.
- Mod can read local data and can also send data out: say what it sends and where.
- Mod can read the conversation and can also send data out: same.
- Mod can read the conversation or other data and submit a prompt: say what goes in the prompts it submits (Discuss, Ask, Plan, Start, the update prompt, the allow-rules prompt, the phone relay).
- Mod runs slash commands itself: say which (`/plan`, `/remote-control`) and when.
- Mod can read the conversation and start an agent: say what it gives the run agents.
- Uses a credential from the user's machine (3 findings): `server/quarterdeck-mcp.mjs` near `raw.githubusercontent.com` (the update check), `server/quarterdeck-cli.mjs` near `schemas.microsoft.com` (the Task Scheduler XML namespace, not a request), and "reads the installer's pat" in `hooks/model.ts` plus `fetch()` in the goal-watches skill. Explain each, or remove what reads a credential.
- Files the validator couldn't inspect, and scripts it couldn't follow: `server/quarterdeck-mcp.mjs` (about 833 KB against a 256 KiB limit). Always held; the README says where the source is.
- Warning: `server/quarterdeck-cli.mjs` contains a download-and-run shell pattern. Find it and say what it is.
- Notes: a call the directory doesn't recognize (an `alerts.ts` call; name the plugin it comes from if any); hooks on `prompt.submit` and `session.receive` (say what they do); `.mcp.json`'s start command isn't in the asked-for form (`--disable-warning=ExperimentalWarning` comes before the script; the script should be first in `args`).

**quarterdeck-guard**:
- Holds: calls tools itself; can fetch and run tools; reads local data and sends data out; reads the conversation and sends data out; has a permission-check hook (say what it decides and when).
- Warnings: answers a tool call in place of the tool (the `status` tool and `SubagentHandback`); changes a tool's input (adds `run_scope`). Say which tools and why.
- Note: hooks `session.send`.

**Both:** notes that mods, local MCP servers, plugin dependencies and non-standard files will later be accepted only from **Verified organizations** (item 11).

## In the portal (item 10)

Each plugin folder is its own submission; do the guard first, as the goals plugin depends on it.

| Field | quarterdeck-guard | quarterdeck-goals |
| --- | --- | --- |
| Type | Plugin bundle | Plugin bundle |
| Repository | `shannonbay/Quarterdeck` | `shannonbay/Quarterdeck` |
| Plugin path | `plugins/quarterdeck-guard` | `plugins/quarterdeck-goals` |
| Branch or tag | `release` | `release` |

The branch must be `release`: only it holds the bundled server and the one-file hooks. Steps: Source → **Validate** → Listing details (check the icon shows: it is taken only once) → Data handling → Compliance → Review and submit. Under "How new versions reach the directory", GitHub push webhook is the default.

## What to expect

- A validation result covers one commit: push, then Re-validate.
- The goals plugin will be held for a reviewer whatever the README says (the server bundle). A hold isn't a rejection.
- A first submission that fails the security scan is rejected, and is resubmitted from its Review tab after a fix.
- Limit: 10 submissions per organisation in 24 hours, drafts and withdrawals included.
- Claude Code only: both plugins are mods, and chat ignores them.
- **The dependency:** someone who adds Quarterdeck from claude.ai gets it as `quarterdeck-goals@synced` and must turn on Quarterdeck Guard too, or no run starts (the pane says so). Say this in the goals README's Install section once both are listed.

## After listing (item 12)

- Add the directory as an install route in the main README and both plugin READMEs.
- Updates follow the `release` branch: each `npm run release` is picked up, scanned and published according to the plugin's publish setting. Keep raising `version` (the script does).
- Delete this file, and the `directory-validate` and `directory-validate-built` branches.

## Docs, worth re-reading because the portal changes

- <https://claude.com/docs/plugins/submit.md>
- <https://claude.com/docs/plugins/pre-submission-checklist.md>
- <https://code.claude.com/docs/en/permissions.md> (allow-rule syntax)
- <https://code.claude.com/docs/en/plugins/mods/admin.md> (how a mod's calls are read)
