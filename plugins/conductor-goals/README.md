# conductor-goals

A Claude Code mod that shows your Conductor goals in a pane beside the chat. It lists each goal's proposals waiting for you with Approve / Reject (rejection feedback becomes goal memory), a Run now button, last/next run and the health trend. It also keeps a status line entry ("Conductor: 2 need you") and raises a toast when a new proposal arrives or a run fails.

It talks only to the Conductor web app (default `http://localhost:3000`), so start it with `npm run dev` in `web/`.

Commands: `/goals` opens the pane, `/goal-run <name>` starts a run, `/conductor-url [url]` shows or sets the web app address.

## Install (from this repo)

```bash
claude plugin marketplace add <path to Conductor repo>
claude plugin install conductor-goals@conductor --scope user
```

Claude Code reads the plugin straight from this folder: after editing, run `/reload-plugins`.

Tests: `claude plugin test plugins/conductor-goals`.
