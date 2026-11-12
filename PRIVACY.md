# Privacy policy

Quarterdeck (the `quarterdeck-goals` and `quarterdeck-guard` Claude Code plugins, the MCP server they bring and the optional web app) runs on your own computer. This page says what it keeps, where, and what leaves your computer.

Last updated: 12 November 2026.

## What Quarterdeck keeps

- **Your goals and to-do lists**: each goal's objective, instructions, schedule, autonomy settings, tool rules and watches.
- **What runs do**: run history and summaries, the items a run adds (proposals, questions, completed actions), what it remembers between runs, your approvals, rejections and answers, the tool calls a run made that the goal's rules cover, and a short label for the tool a run is using now.
- **Health checks and watches**: the output of the commands you set for them.

A goal works through the tools and connectors you already use with Claude Code, so a run can read whatever those reach (your mail, for example) when the goal's instructions ask it to. What a run reads is handled by Claude Code and those tools under their own terms; Quarterdeck keeps only what the run writes back to it.

## Where it is kept

In one SQLite file on your computer, `~/.quarterdeck/tasks.db` (or the path in `QUARTERDECK_DB`). The standing session, if you install it, keeps its state in `~/.quarterdeck/runner`. Nothing is kept anywhere else, and there is no Quarterdeck account or server.

## What leaves your computer

Quarterdeck itself sends nothing about you or your goals anywhere. It makes two kinds of network request:

- **Update check**: at most every 6 hours, the MCP server downloads the latest released `plugin.json` from GitHub (`raw.githubusercontent.com/shannonbay/Quarterdeck`) to tell you when a newer version is out. The request carries nothing about you; GitHub sees it as an ordinary download from your internet address. Turn it off with `QUARTERDECK_UPDATE_CHECK=0`.
- **One-click unsubscribe**: when a goal carries out an unsubscribe you approved (or one in a category you set to `auto`), the MCP server sends one request to the unsubscribe link in that mailing list's own message, as the email standard (RFC 8058) describes. It goes only to the sender's link, with no data beyond what that standard sends.

Everything a goal run does beyond that goes through Claude Code, Claude and your own tools and connectors, under Anthropic's terms and theirs.

The optional web app listens only on your own computer (localhost) and refuses requests from other sites.

## How long it is kept

Until you delete it. Delete a goal, memory or to-do from the Goals pane, or remove everything by uninstalling the plugins and deleting the `~/.quarterdeck` folder.

## Children

Quarterdeck is not intended for people under 18.

## Questions

Open an issue at <https://github.com/shannonbay/Quarterdeck/issues>.
