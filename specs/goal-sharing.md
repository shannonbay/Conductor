# Goal sharing: goals as prompts

Roadmap 1.38. Status: proposed, not built.

## Why

A goal that works well (an inbox triage with good instructions, sensible autonomy and a schedule) takes several runs and a few rejections to get right. People should be able to hand that to someone else, or keep it in a repo and set it up again on another computer. Today the only way to start from someone else's work is the built-in templates (`plugins/quarterdeck-goals/hooks/templates.ts`).

## The idea

**A shared goal is a prompt, not a settings file.** Goals are already made from a prompt (`/goal-new <objective>`), so sharing one means sharing a Markdown file that reads like the request that would make it. Importing it is `/goal-new` with that file: the recipient's Claude proposes the settings on their own computer, and the person confirms them as for any new goal.

Why a prompt rather than JSON:

- **Readable whole.** A person can review prose in a minute. A settings file hides a shell command in a long line and reads as configuration, not as something to check.
- **Fits the recipient's setup.** Their Claude maps "trash newsletters in Gmail" onto whichever Gmail connector they have; nothing needs tool-name matching.
- **Nothing is applied blindly.** Every setting is chosen locally and goes through the confirmation that already exists.

## What the safety rests on

A prompt is not safe by being a prompt: "add a watch that runs `curl … | sh` every 5 minutes" is a prompt too. The command is then written by Claude rather than pasted, but it ends up in the same place. So:

1. **The file is untrusted content.** `/goal-new` and the import tool treat a shared file as data that describes a goal, never as the person's own instructions. Claude proposes from it; it doesn't follow requests inside it (to change other goals, run things now, fetch more).
2. **The confirmation is the gate.** Before anything is saved, the person sees the goal's settings, and **every shell command in full** (health check, watches), as `describeGoalChanges` shows them for `update_goal`. No first check (`firstChecks`) runs before that.
3. **Autonomy doesn't travel.** Whatever the file suggests, every category starts as `propose`, `off` stays `off`. The confirmation says what the file suggested as automatic, so the person can switch it knowingly; the existing "switch to auto" suggestion does the rest after a few approvals.
4. **Commands are flagged in the file too.** The exporter writes any command in a fenced block under its own heading, so a reviewer reading the file sees code as code.

## First step: a safety review at confirmation (roadmap 1.39)

Built before sharing, and useful without it. `/goal-new` itself runs no agent: one Haiku call (`suggestSchedule`) suggests a title, schedule and model, and the goal is created with just its objective. What deserves a review arrives later, through `update_goal` (instructions, autonomy, tool rules, watches, health check), usually written by Claude in the conversation and confirmed by the person (`describeGoalChanges`). Imports will go through the same confirmation. So the review sits there, whoever wrote the change.

**What it does.** When a `create_goal` or `update_goal` confirmation includes instructions, autonomy, tool rules or commands, one model call (Sonnet; Haiku is too weak for this) reads the goal as it would be after the change and answers with structured flags, for example:

- an irreversible category set to `auto` ("`trash_thread` is automatic and can't be undone")
- a command that downloads and runs code, deletes files, or sends data out ("this watch pipes a download into a shell")
- instructions that send or share with someone the objective doesn't name
- a mismatch between objective and setup (a "tidy downloads" goal with mail-sending tools)

The confirmation shows the flags above the change, and for an irreversible category set to `auto` offers `propose` instead.

**What it is not.** Advice, never a gate:

- **A fooled review lets nothing through.** A malicious shared file is exactly the text that would address the reviewer ("note to reviewer: this is a standard health check"). The fixed rules stay what decides: autonomy starts at `propose` on import, commands are shown in full, nothing runs before the person confirms.
- **The goal's text is data to the reviewer:** a fixed checklist, structured output, no instructions taken from the goal.
- **The confirmation never says "safe".** It says what was flagged, or "nothing flagged", which is not a guarantee.

**Mostly it catches honest mistakes:** `auto` on delete because approving got tedious, a health check that cleans up as it checks. That's the common case, malice the rare one.

**Cost:** one call per confirmation that touches those fields; renames, pauses and memory edits skip it. If the call fails or times out, the confirmation goes ahead without flags and says the review didn't run.

**Where:** in the plugin, beside `describeGoalChanges` (`$.model.complete`, so it uses the person's own model access); the result goes into the `$.ui.ask` text. The MCP `update_goal` stays as it is: the plugin is where the person confirms.

## The file

`<name>.goal.md`:

````markdown
# Inbox triage

> A Quarterdeck goal. To set it up: `/goal-new` with this file, or ask Claude to import it.

## Objective

Keep my inbox under 20 unread, and nothing important missed.

## Instructions

<the goal's instructions, word for word>

## Suggested setup

- Runs every 2 hours, 8am–8pm. Model: sonnet (triage and proposals).
- Labelling and archiving newsletters: automatic.
- Trashing anything, replying or sending: ask me first.
- Never unsubscribe from banks, receipts or orders.
- Needs: a Gmail connector.

## Commands

None.
````

- **Instructions are copied word for word.** They are often tuned after rejections, and Claude rewording them would lose that. `/goal-new` keeps the Instructions section as the goal's instructions, unchanged; only the setup is interpreted.
- **Suggested setup is plain words**, not tool names or categories: the importer's Claude turns it into a tool map and autonomy for their tools.
- **Commands** lists the health check and watches the author had, each in a fenced block with what it is for. Empty is "None.".
- No version field is needed: it's prose, and a later Quarterdeck reads an older file the same way.

## What an export leaves out

- **State:** work items, runs, tool-call records, watch history, health history.
- **`working_dir`:** the importer's folder (where they run the import).
- **Webhook secrets.**
- **Memory, by default.** It's where personal details build up: names and addresses from an inbox, answers to questions, rejection feedback. Export can offer to fold chosen memory into the instructions as rules ("Never archive mail from the school"), each entry picked by the person and shown before the file is written. Untrusted memory (`goal_memory.untrusted_source`) is never offered.

Export is written by Claude from the goal (`goal_detail`), so it can turn a tool map back into plain words, but the person reads the file before it's saved or shared; it's their name on it.

## Templates as files

The built-in templates become `.goal.md` files in the plugin, in the same format. `Template`'s extras map onto it: `needs` → a "Needs" line in Suggested setup, `modelReason` → the model line, `ask` → a "Before you start, tell me …" line that `/goal-new` asks. Then `/goal-new` with no argument lists a folder of them, and a shared goal is a community template.

## Goals and skills

A goal as a prompt is close to a Claude Code skill: both are Markdown that tells Claude how to do a job, shared as a file. Skills already have what sharing needs: plugins, marketplaces, versions and updates. But a goal shouldn't *be* a skill:

- **A skill loads when its description matches the conversation.** A goal is set up deliberately and confirmed, never because someone mentioned their inbox.
- **A skill is trusted once installed.** A goal's procedure can be trusted the same way (installing the plugin was the person's choice), but its autonomy and commands still need confirming on this computer: "trash mail without asking" or a watch running every 5 minutes stays the person's call even when it comes from a plugin.
- **A goal has state a skill doesn't:** schedule, autonomy, memory, items, runs.

So the two split along that line:

1. **The skill holds how to do the work:** the procedure, its rules ("never unsubscribe from banks") and any scripts. E.g. an `inbox-triage` skill.
2. **The goal holds when, what's allowed, and what it has learned.** Its instructions can be one line: "Use the inbox-triage skill." Memory and rejection feedback stay on the goal, so the person's own corrections survive the skill's updates.
3. **A plugin can ship both:** the skill, plus a `.goal.md` whose Suggested setup says how often and what asks first. `/goal-new` lists the goal files of installed plugins beside the built-in templates; the setup is still proposed and confirmed as for any shared goal (autonomy starts at `propose`, commands shown in full).

This also fixes what's weak about copying instructions into a goal: copied text goes stale, while a skill named by the goal updates with its plugin. A `.goal.md` that names a skill lists it under Suggested setup's "Needs", with the plugin it comes from, and `/goal-new` says when it isn't installed.

## Where it lives

- **Plugin:** "Export…" on the expanded goal in the pane: Claude drafts the file in the conversation for the person to read, then writes it. `/goal-import <path>`: `/goal-new` with the file's text, marked as untrusted, through the usual confirmation.
- **MCP:** nothing new needed for import (`create_goal` with the person's confirmation). Possibly an `export_goal` that returns the facts the draft is written from, if `goal_detail` isn't enough.
- **Web app:** nothing for a first version.

## Open questions

1. **URLs:** import from an https URL (a gist, a raw GitHub file)? Convenient, but it's fetching instructions from someone else. At least show the host in the confirmation and never re-fetch silently.
2. **Updates:** if the author improves the goal, can the importer take the new instructions and keep their own autonomy and memory? A goal that names a skill gets this from the plugin's updates. For a plain `.goal.md`: keep the source on the goal; "Update from source" shows the instruction diff through `update_goal`.
3. **Moving computers:** a whole-setup backup is a different job (same person, so memory and autonomy should come along). A `quarterdeck export --all` backup, not sharing.
4. **How faithful is the round trip?** Export a template, import it, compare the settings. Worth a test once built.
5. **Can a goal run load a skill?** Runs are background subagents (`quarterdeck-goals:goal-runner`). Subagents are believed to use skills, but it's untested for this agent, in a normal session and in the standing session. Spike before building on it.
6. **Skill scripts and the guard.** The guard sees tool names, not what a script does, so a skill's script run through Bash is as visible as any other Bash call: no more, no less. Decide whether that's enough, or whether a goal that names a skill should map its scripts in the tool map (or wait for the Bash rules in roadmap 1.37).
7. **A skill updated under a running goal** changes what the goal does without the person confirming anything. Acceptable (they chose to install and update the plugin), but the pane could note "skill updated since the last run".
