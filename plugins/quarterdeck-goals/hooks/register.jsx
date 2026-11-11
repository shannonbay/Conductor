// quarterdeck-goals's hooks in one file, built by scripts/bundle-hooks.mjs for the plugin directory, which reads a mod's calls
// from the file that registers its hooks. Not minified. The source, with its comments and types, is in
// plugins/quarterdeck-goals/hooks/ on the main branch of https://github.com/shannonbay/Quarterdeck.

// names.ts
var SERVER_PREFIXES = ["mcp__plugin_quarterdeck-goals_quarterdeck__", "mcp__quarterdeck__"];
function serverToolNames(...tools) {
  return tools.flatMap((t) => SERVER_PREFIXES.map((p) => p + t));
}

// api.ts
var DEFAULT_URL = "http://localhost:3000";
var settings = { url: DEFAULT_URL, pollSeconds: 15, alerts: "all", osNotifications: true, phonePush: false, phoneRelay: true, maxConcurrent: 2 };
function configure(options) {
  const url = typeof options.url === "string" && options.url.trim() ? options.url.trim() : DEFAULT_URL;
  const poll = typeof options.poll_seconds === "number" ? options.poll_seconds : 15;
  const concurrent = typeof options.max_concurrent_runs === "number" ? options.max_concurrent_runs : 2;
  settings.url = url.replace(/\/+$/, "");
  settings.pollSeconds = Math.min(Math.max(Math.round(poll), 5), 600);
  settings.alerts = typeof options.alerts === "string" ? options.alerts : "all";
  settings.osNotifications = options.os_notifications !== false;
  settings.phonePush = options.phone_push === true;
  settings.phoneRelay = options.phone_relay !== false;
  settings.maxConcurrent = Math.min(Math.max(Math.round(concurrent), 1), 5);
}
async function baseUrl($) {
  if (settings.url !== DEFAULT_URL) return settings.url;
  const stored = await $.store.get("url");
  return typeof stored === "string" && /^https?:\/\//.test(stored) ? stored.replace(/\/+$/, "") : DEFAULT_URL;
}
function resultText(r) {
  if (typeof r.text === "string") return r.text;
  const res = r.result;
  if (typeof res === "string") return res;
  if (Array.isArray(res)) return res.map((b) => typeof b === "object" && b && "text" in b ? String(b.text) : "").join("");
  return JSON.stringify(res ?? null);
}
var NOT_LOADED = "The quarterdeck MCP server isn't loaded in this session. It comes with this plugin: check it in /mcp (plugin:quarterdeck-goals:quarterdeck), or run /reload-plugins. `npm run doctor` in the Quarterdeck folder says more.";
function isNotLoaded(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /no tool named "mcp__(plugin_quarterdeck-goals_)?quarterdeck__|no such tool available: mcp__(plugin_quarterdeck-goals_)?quarterdeck__|no implementation for tool\.call/i.test(msg);
}
var serverPrefix = null;
async function call($, name, input = {}) {
  const order = serverPrefix ? [serverPrefix, ...SERVER_PREFIXES.filter((p) => p !== serverPrefix)] : [...SERVER_PREFIXES];
  let r;
  for (const prefix of order) {
    try {
      const answer = await $.tool.call({ tool: `${prefix}${name}`, ...input });
      if (isNotLoaded(resultText(answer))) continue;
      serverPrefix = prefix;
      r = answer;
      break;
    } catch (err) {
      if (!isNotLoaded(err)) throw err;
    }
  }
  if (r === void 0) throw new Error(NOT_LOADED);
  if (r.deny !== void 0) throw new Error(r.deny);
  const text = resultText(r);
  if (r.isError === true || text.startsWith("Error:")) throw new Error(text.replace(/^Error:\s*/, "").replace(/^<tool_use_error>|<\/tool_use_error>$/g, ""));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(/persisted-output|Output too large/.test(text) ? `Quarterdeck's answer to ${name} was too large to read (Claude Code saved it to a file). Update Quarterdeck, or tell its developer.` : `Unexpected answer from quarterdeck: ${text.slice(0, 200)}`);
  }
}
async function fetchOverview($, etag, detail = []) {
  const res = await call($, "goals_overview", { ...etag ? { etag } : {}, detail: [...detail] });
  if (!res.changed) return { changed: false };
  return { changed: true, goals: res.goals ?? [], etag: res.etag, hold: res.hold ?? null, outdated: res.outdated === true, standing: res.standing === true, update: res.update ?? null };
}
async function updateGoal($, goalId, changes) {
  const r = await call($, "update_goal", { goal_id: goalId, ...changes });
  return { changed: r.changed, watches: r.watches ?? [] };
}
async function deleteGoal($, goalId) {
  await call($, "delete_goal", { goal_id: goalId });
}
async function answerItem($, goalId, itemId, text) {
  await call($, "decide_item", { goal_id: goalId, item_id: itemId, decision: "answer", feedback: text });
}
async function approve($, goalId, itemId) {
  await call($, "decide_item", { goal_id: goalId, item_id: itemId, decision: "approve" });
}
async function reject($, goalId, itemId, feedback) {
  await call($, "decide_item", { goal_id: goalId, item_id: itemId, decision: "reject", feedback });
}
async function runNow($, goalId) {
  await call($, "run_goal", { goal_id: goalId });
}
async function cancelRunRecord($, goalId) {
  const r = await call($, "cancel_run", { goal_id: goalId });
  return { runId: r.cancelled, agentId: r.agent_id };
}
async function setGoalStatus($, goalId, status) {
  await call($, "set_goal_status", { goal_id: goalId, status });
}
async function deleteMemory($, goalId, memoryId) {
  await call($, "delete_memory", { goal_id: goalId, memory_id: memoryId });
}
async function setSchedule($, goalId, schedule, oneOff = false) {
  return call($, "set_schedule", { goal_id: goalId, schedule, ...oneOff && { one_off: true } });
}
async function createGoal($, input) {
  return call($, "create_goal", input);
}
async function tick($, holder, trackedRunIds, toolWatches = true) {
  const r = await call($, "goals_tick", {
    holder,
    tracked_run_ids: trackedRunIds,
    max_concurrent: settings.maxConcurrent,
    ...toolWatches && { tool_watches: true }
  });
  return { leader: r.leader, claimed: r.claimed ?? [], toolWatches: r.tool_watches ?? [] };
}
async function reportWatch($, watchId, report) {
  return call($, "watch_report", { watch_id: watchId, ...report });
}
async function releaseLease($, holder) {
  await call($, "goals_tick", { holder, release: true });
}
async function attachAgent($, runId, agentId) {
  await call($, "attach_agent", { run_id: runId, agent_id: agentId });
}
async function failRun($, runId, status, reason) {
  return call($, "fail_run", { run_id: runId, status, reason });
}
async function fetchTodos($, dir) {
  return (await call($, "todo_list", { working_dir: dir })).lists;
}
async function addTodo($, input) {
  return call($, "todo_add", { working_dir: input.dir, text: input.text, added_by: input.by ?? "human", ...input.listId && { list_id: input.listId } });
}
async function setTodo($, listId, itemId, status, notes) {
  await call($, "todo_set", { list_id: listId, item_id: itemId, status, ...notes !== void 0 && { notes } });
}
async function editTodo($, listId, itemId, input) {
  await call($, "todo_set", { list_id: listId, item_id: itemId, text: input.text, changed_by: input.by, ...input.notes !== void 0 && { notes: input.notes } });
}

// model.ts
var EMPTY = { reachable: false, error: null, goals: [], fetchedAt: 0, etag: null, hold: null };
function toItem(t) {
  return { id: t.id, title: t.goal, category: t.action?.category ?? null, summary: t.action?.summary ?? null, ...t.asks_person && { asksPerson: true } };
}
function toCard(g) {
  const latest = g.health[0];
  return {
    id: g.id,
    name: g.name,
    objective: g.objective,
    status: g.status,
    // An older web app sends no activity: say nothing rather than guess.
    activity: g.activity ?? { state: g.status === "paused" ? "paused" : "idle", text: "", at: null },
    needsYou: g.needs_you.map(toItem),
    detail: g.detail !== false,
    needsYouCount: g.needs_you_count ?? g.needs_you.length,
    openItems: g.open_items.map(toItem),
    openItemCount: g.open_item_count,
    openRun: g.open_run ? { id: g.open_run.id, status: g.open_run.status } : null,
    runs: g.runs.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, summary: r.summary, startedAt: r.started_at, endedAt: r.ended_at, agentId: r.agent_id ?? null, tokens: r.tokens ?? 0 })),
    nextRunAt: g.next_run_at,
    schedule: g.schedule ?? null,
    oneOff: g.one_off ?? false,
    instructions: g.instructions ?? "",
    autonomy: g.autonomy ?? {},
    toolMap: g.tool_map ?? {},
    health: latest ? { passed: latest.passed, value: latest.value } : null,
    trend: g.health.map((check) => check.value).filter((v) => v !== null).reverse(),
    memory: g.memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, pinned: m.pinned })),
    suggestions: g.suggestions.map((s) => ({ category: s.category, approvedInARow: s.approved_in_a_row })),
    watches: (g.watches ?? []).map((w) => ({ name: w.name, everyMinutes: w.every_minutes, runs: w.runs, lastFiredAt: w.last_fired_at, failing: w.failing, error: w.error })),
    watchCount: g.watch_count ?? g.watches?.length ?? 0,
    watchFailing: g.watch_failing ?? (g.watches ?? []).some((w) => w.failing)
  };
}
function lastRun(g) {
  return g.runs.find((r) => r.status !== "queued" && r.status !== "running") ?? null;
}
function isFailed(status) {
  return status === "failed" || status === "timed_out";
}
function isQuiet(g) {
  const run = lastRun(g);
  return g.needsYou.length === 0 && g.needsYouCount === 0 && !g.openRun && !(run && isFailed(run.status)) && !(g.health && !g.health.passed) && !g.watchFailing && g.suggestions.length === 0;
}
function findGoal(goals, query) {
  const q = query.trim().toLowerCase();
  if (!q) return { matches: [] };
  const byId = goals.find((g) => g.id === query.trim());
  if (byId) return { goal: byId };
  for (const test of [(n) => n === q, (n) => n.startsWith(q), (n) => n.includes(q)]) {
    const hits = goals.filter((g) => test(g.name.toLowerCase()));
    if (hits.length === 1) return { goal: hits[0] };
    if (hits.length > 1) return { matches: hits };
  }
  return { matches: [] };
}
function noMatch(goals, query, matches) {
  if (matches.length > 1) return `"${query.trim()}" matches ${matches.map((g) => g.name).join(", ")}. Be more specific.`;
  if (goals.length === 0) return "There are no goals yet.";
  return `No goal matches "${query.trim()}". Goals: ${goals.map((g) => g.name).join(", ")}.`;
}
function diffAlerts(seen2, goals) {
  const items = goals.flatMap((goal) => goal.needsYou.map((item) => ({ key: `${goal.id}/${item.id}`, goal, item })));
  const failed = goals.flatMap((goal) => {
    const run = lastRun(goal);
    return run && isFailed(run.status) ? [{ goal, run }] : [];
  });
  const next = { items: items.map((x) => x.key), failures: failed.map((f) => f.run.id) };
  if (!seen2) return { proposals: [], failures: [], seen: next };
  return {
    proposals: items.filter((x) => !seen2.items.includes(x.key)).map(({ goal, item }) => ({ goal, item })),
    failures: failed.filter((f) => !seen2.failures.includes(f.run.id)),
    seen: next
  };
}
function statusText(s) {
  if (!s.reachable) return "Quarterdeck: offline";
  if (s.goals.length === 0) return void 0;
  const waiting = s.goals.reduce((n, g) => n + g.needsYou.length, 0);
  const running = s.goals.filter((g) => g.openRun?.status === "running").map((g) => g.name);
  const parts = [
    waiting > 0 ? `${waiting} need${waiting === 1 ? "s" : ""} you` : null,
    running.length > 0 ? `${running.join(", ")} running` : null
  ].filter(Boolean);
  return `Quarterdeck: ${parts.length > 0 ? parts.join(" · ") : "all clear"}`;
}
function summarize(goals, now) {
  if (goals.length === 0) return "No Quarterdeck goals exist yet.";
  return goals.map((g) => {
    const run = lastRun(g);
    const lines = [
      `## ${g.name} (id ${g.id}, ${g.status === "retired" ? "done" : g.status}${g.oneOff ? ", one-off" : ""})`,
      `Objective: ${g.objective}`,
      g.activity.text ? `Now: ${g.activity.text}` : null,
      g.openRun ? `Run ${g.openRun.status} now.` : `Last run: ${run ? `${run.status} ${ago(run.endedAt ?? run.startedAt, now)}${runCost(run) ? ` (${runCost(run)})` : ""}${run.summary ? ` — ${run.summary}` : ""}` : "none"}.`,
      g.health ? `Health: ${g.health.passed ? "passing" : "failing"}${g.health.value !== null ? ` (${g.health.value})` : ""}.` : null,
      `Open items: ${g.openItemCount}.`,
      g.needsYou.length === 0 ? "Nothing waiting for approval." : `Waiting for you:
${g.needsYou.map((i) => `- item ${i.id}: ${i.title}${i.asksPerson ? " [a question for you: answer with answer_item, or approve_item when done]" : ""}${i.category ? ` [${i.category}]` : ""}${i.summary ? ` — ${i.summary}` : ""}`).join("\n")}`
    ];
    return lines.filter(Boolean).join("\n");
  }).join("\n\n");
}
function describe(g, now) {
  return [
    summarize([g], now),
    g.openItems.length > 0 ? `Open items${g.openItemCount > g.openItems.length ? ` (first ${g.openItems.length} of ${g.openItemCount})` : ""}:
${g.openItems.map((i) => `- item ${i.id}: ${i.title}`).join("\n")}` : null,
    g.runs.length > 0 ? `Recent runs:
${g.runs.map((r) => `- ${r.status} (${r.trigger}) ${ago(r.endedAt ?? r.startedAt, now)}${r.summary ? ` — ${r.summary}` : ""}`).join("\n")}` : null,
    g.instructions.trim() ? `Instructions: ${g.instructions.trim()}` : null,
    `Schedule: ${g.oneOff ? "one-off" : scheduleLabel(g.schedule)}`,
    g.watches.length > 0 ? `Watches (a run starts when one sees a new line):
${g.watches.map((w) => `- ${w.name}: every ${w.everyMinutes} min, runs ${w.runs}${w.failing ? ` [failing: ${w.error ?? "no message"}]` : ""}${w.lastFiredAt ? `, last saw something new ${ago(w.lastFiredAt, now)}` : ""}`).join("\n")}` : null,
    `Autonomy (unlisted categories: propose): ${Object.entries(g.autonomy).map(([c, m]) => `${c}=${m}`).join(", ") || "none set"}`,
    Object.keys(g.toolMap).length ? `Tool rules: ${Object.entries(g.toolMap).map(([p, c]) => `${p} → ${c}`).join(", ")}` : null,
    g.memory.length > 0 ? `Memory:
${g.memory.map((m) => `- ${m.id} [${m.kind}${m.pinned ? ", pinned" : ""}] ${m.text}`).join("\n")}` : null
  ].filter(Boolean).join("\n\n");
}
function clip(text, columns) {
  const chars = [...text];
  if (chars.length <= columns) return text;
  return columns <= 1 ? "…".slice(0, columns) : `${chars.slice(0, columns - 1).join("").trimEnd()}…`;
}
var BARS = "▁▂▃▄▅▆▇█";
function spark(values) {
  if (values.length < 2) return "";
  const shown = values.slice(-12);
  const min = Math.min(...shown);
  const span = Math.max(...shown) - min || 1;
  return shown.map((v) => BARS[Math.round((v - min) / span * (BARS.length - 1))]).join("");
}
function ago(iso, now) {
  if (!iso) return "—";
  const s = Math.round((now - Date.parse(iso)) / 1e3);
  if (s < 0) {
    const m = Math.round(-s / 60);
    return m < 1 ? "in <1m" : m < 60 ? `in ${m}m` : m < 1440 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`;
  }
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
var SCHEDULE_USAGE = "every 30m | 6h | 30d | 2 weeks | daily | weekly | monthly [between 08:00-20:00] | cron <5 fields> | one-off | off";
var UNIT_MINUTES = {
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
  w: 10080,
  wk: 10080,
  wks: 10080,
  week: 10080,
  weeks: 10080
};
var WORD_INTERVALS = {
  hourly: "1h",
  daily: "1d",
  "every day": "1d",
  nightly: "1d",
  weekly: "1w",
  "every week": "1w",
  fortnightly: "2w",
  biweekly: "2w",
  monthly: "30d",
  "every month": "30d",
  "every hour": "1h"
};
function parseSchedule(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "off" || t === "manual" || t === "none") return { schedule: null };
  if (t === "one-off" || t === "oneoff" || t === "one off" || t === "once") return { schedule: null, oneOff: true };
  if (t.startsWith("cron ")) {
    const expr = text.trim().replace(/^cron\s+/i, "").trim();
    return expr.split(/\s+/).length === 5 ? { schedule: { kind: "cron", expr } } : { error: 'A cron expression has 5 fields (minute hour day month weekday), e.g. "cron 0 9 * * 1-5".' };
  }
  const words = Object.entries(WORD_INTERVALS).find(([w]) => t === w || t.startsWith(`${w} between `));
  const spelled = words ? `${words[1]}${t.slice(words[0].length)}` : t;
  const m = /^(?:every )?(\d+) ?([a-z]+)(?: between (\d{1,2}):(\d{2}) ?- ?(\d{1,2}):(\d{2}))?$/.exec(spelled);
  if (!m) return { error: `Say when it runs: ${SCHEDULE_USAGE}.` };
  const unit = UNIT_MINUTES[m[2]];
  if (!unit) return { error: 'Use minutes, hours, days or weeks for the interval, e.g. "every 6h" or "30d".' };
  const minutes = Number(m[1]) * unit;
  if (minutes < 5) return { error: "Goals run at most every 5 minutes." };
  const schedule = { kind: "interval", minutes };
  if (m[3] !== void 0) {
    const hours = [Number(m[3]), Number(m[5])];
    const mins = [Number(m[4]), Number(m[6])];
    if (hours.some((hour) => hour > 23) || mins.some((x) => x > 59)) return { error: 'Use 24-hour times, e.g. "between 08:00-20:00".' };
    const pad = (n) => String(n).padStart(2, "0");
    schedule.active_hours = `${pad(hours[0])}:${pad(mins[0])}-${pad(hours[1])}:${pad(mins[1])}`;
  }
  return { schedule };
}
function scheduleLabel(s) {
  if (!s) return "on demand";
  if (s.kind === "cron") return `cron ${s.expr}`;
  const every = s.minutes % 1440 === 0 ? `${s.minutes / 1440}d` : s.minutes % 60 === 0 ? `${s.minutes / 60}h` : `${s.minutes}m`;
  return `every ${every}${s.active_hours ? `, ${s.active_hours.replace("-", "–")}` : ""}`;
}
function nextRunText(g, now) {
  if (g.status !== "active" || g.openRun) return "";
  if (g.oneOff) return " · one-off";
  if (g.nextRunAt) return Date.parse(g.nextRunAt) <= now ? " · next run due now" : ` · next ${ago(g.nextRunAt, now)}`;
  return g.schedule === null ? " · no schedule" : "";
}
var SCHEDULE_CHOICES = [
  { key: "hourly", label: "Every hour", schedule: { kind: "interval", minutes: 60 }, oneOff: false },
  { key: "6h", label: "Every 6 hours", schedule: { kind: "interval", minutes: 360 }, oneOff: false },
  { key: "daily", label: "Daily", schedule: { kind: "interval", minutes: 1440 }, oneOff: false },
  { key: "weekly", label: "Weekly", schedule: { kind: "interval", minutes: 10080 }, oneOff: false },
  { key: "one-off", label: "One-off: run once now", schedule: null, oneOff: true },
  { key: "on-demand", label: "Only when I run it", schedule: null, oneOff: false }
];
var SUGGESTED = " (suggested)";
var ALTERNATIVES = ["daily", "weekly", "one-off", "hourly", "6h"];
function choiceOptions(suggested) {
  const first = SCHEDULE_CHOICES.find((c) => c.key === suggested);
  const rest = ALTERNATIVES.filter((k) => k !== suggested).slice(0, 3).map((k) => SCHEDULE_CHOICES.find((c) => c.key === k).label);
  return [first.label + SUGGESTED, ...rest];
}
function readAnswer(answer) {
  if (!answer || /^cancel$/i.test(answer.trim())) return null;
  const label = answer.endsWith(SUGGESTED) ? answer.slice(0, -SUGGESTED.length) : answer;
  const listed = SCHEDULE_CHOICES.find((c) => c.label === label);
  if (listed) return { choice: listed };
  const typed = parseSchedule(answer);
  if ("error" in typed) return { error: typed.error };
  const text = typed.oneOff ? "one-off" : scheduleLabel(typed.schedule);
  return { choice: { key: "custom", label: text, schedule: typed.schedule, oneOff: typed.oneOff ?? false } };
}
var KEYWORDS = [
  [/\b(once|one[- ]?off|install|set ?up|setup|migrate|migration|upgrade|fix|bootstrap)\b/, { choice: "one-off", reason: "it reads like a single task" }],
  [/\b(inbox|triage|alerts?|notifications?|on[- ]call|incidents?)\b/, { choice: "hourly", reason: "new things arrive all the time" }],
  [/\b(weekly|reports?|digest|summary|summaries|review)\b/, { choice: "weekly", reason: "it sums up a period" }],
  [/\b(monitor|watch|track|keep an eye)\w*/, { choice: "6h", reason: "it watches for changes" }],
  [/\b(maintain|keep|check|update|sync|backup|back up|clean|tidy|current)\w*/, { choice: "daily", reason: "it is ongoing upkeep" }]
];
function suggestByKeywords(name, objective) {
  const text = `${name} ${objective}`.toLowerCase().replace(/[-_]/g, " ");
  for (const [re, suggestion] of KEYWORDS) if (re.test(text)) return suggestion;
  return { choice: "daily", reason: "goals are ongoing unless they are clearly one-offs" };
}
function parseSuggestion(text) {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    const choice = SCHEDULE_CHOICES.find((c) => c.key === v.choice && c.key !== "on-demand");
    if (!choice) return null;
    const reason = typeof v.reason === "string" && v.reason.trim() ? v.reason.trim().replace(/\.$/, "") : "suggested from its objective";
    const title = typeof v.title === "string" ? cleanTitle(v.title) : "";
    return { choice: choice.key, reason, ...title && { title } };
  } catch {
    return null;
  }
}
var TITLE_MAX = 40;
function cleanTitle(text) {
  const t = text.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`.]+$/g, "").trim();
  return t.length > TITLE_MAX ? clip(t, TITLE_MAX) : t;
}
var FILLER = /* @__PURE__ */ new Set(["a", "an", "the", "my", "our", "to", "please", "and", "of", "for", "in", "on", "that", "so", "it", "is"]);
function fallbackTitle(objective) {
  const words = objective.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w && !FILLER.has(w.toLowerCase()));
  const title = words.slice(0, 5).join(" ");
  return cleanTitle(title ? title[0].toUpperCase() + title.slice(1) : "New goal");
}
function splitGoalArgs(args) {
  const text = args.trim();
  const at = text.indexOf(":");
  if (at > 0) {
    const name = text.slice(0, at).trim();
    const objective = text.slice(at + 1).trim();
    if (objective && name.length <= TITLE_MAX && name.split(/\s+/).length <= 5) return { name, objective };
  }
  return { name: null, objective: text };
}
function discussPrompt(g, run, question) {
  const how = "Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm.";
  const asked = question?.trim();
  if (!run) {
    return asked ? `Let's talk about my goal "${g.name}" (id ${g.id}). ${how}

My question: ${asked}` : `Let's talk about my goal "${g.name}" (id ${g.id}). ${how} What's working, what isn't, and what would you change?`;
  }
  const when = `${run.status} (${run.trigger}), ${run.endedAt ?? run.startedAt}`;
  const transcript = run.agentId ? ` Its agent was ${run.agentId}: its transcript (agent-${run.agentId}.jsonl, under ~/.claude/projects) shows what it actually did.` : "";
  if (asked) {
    return `Let's talk about this run of my goal "${g.name}" (goal ${g.id}, run ${run.id}): ${when}.

Its summary: ${run.summary ?? "(none)"}

${`${transcript} ${how}`.trim()}

My question: ${asked}`;
  }
  return `Let's talk about this run of my goal "${g.name}" (goal ${g.id}, run ${run.id}): ${when}.

Its summary: ${run.summary ?? "(none)"}

${isFailed(run.status) ? "Why did it fail, and what should change so it doesn't again?" : "Is this what should have happened, and what should change?"}${transcript} ${how}`;
}
function updatePrompt(u) {
  return [
    `Quarterdeck ${u.latest} is available (I have ${u.installed}). Please install it:`,
    "",
    "1. `claude plugin marketplace update quarterdeck`",
    "2. `claude plugin update quarterdeck-goals@quarterdeck`",
    "3. `claude plugin update quarterdeck-guard@quarterdeck`",
    "",
    "Tell me what each one answered. If they worked, remind me to run /reload-plugins in every open Claude Code session (only I can type that), and that goal runs wait in a session until it has. If one failed, say why and don't try anything else without asking me."
  ].join("\n");
}
var WATCH_DEFAULT_MINUTES = 5;
function soundsEventDriven(objective) {
  return /\b(when(ever)?|as soon as|each time|every time)\b.{0,60}\b(new|opens?|opened|arrives?|appears?|posted|published|changes?|is (created|added|merged|released))\b|\bnew (issues?|prs?|pull requests?|releases?|posts?|commits?|emails?|messages?|files?)\b/i.test(objective);
}
function describeGoalChanges(g, c) {
  const lines = [];
  if (c.name && c.name !== g.name) lines.push(`Name: "${g.name}" → "${c.name}"`);
  if (c.objective && c.objective !== g.objective) lines.push(`Objective → ${c.objective}`);
  if (c.instructions !== void 0 && c.instructions !== g.instructions) lines.push(c.instructions.trim() ? `Instructions → ${c.instructions}` : "Instructions: cleared");
  for (const [cat, mode] of Object.entries(c.autonomy ?? {})) lines.push(`${cat}: ${g.autonomy[cat] ?? "propose"} → ${mode ?? "propose (default)"}`);
  for (const [pat, cat] of Object.entries(c.tool_map ?? {})) lines.push(cat === null ? `Tool rule removed: ${pat}` : `Tool rule: ${pat} → ${cat}`);
  for (const m of c.add_memory ?? []) lines.push(`Remember (${m.kind}${m.pinned ? ", pinned" : ""}): ${m.text}`);
  for (const id of c.forget_memory ?? []) lines.push(`Forget: ${g.memory.find((m) => m.id === id)?.text ?? id}`);
  for (const [name, w] of Object.entries(c.watches ?? {})) {
    const had = g.watches.some((x) => x.name === name.trim());
    if (w === null) lines.push(`Watch removed: ${name}`);
    else if (w.tool) lines.push(`${had ? "Watch changed" : "New watch"} "${name.trim()}": every ${w.every_minutes ?? WATCH_DEFAULT_MINUTES} min this tool is called without asking you, and a run starts when its answer has something it hasn't before: ${w.tool} ${JSON.stringify(w.input ?? {})}${w.match ? ` (read with ${w.match})` : ""}`);
    else lines.push(`${had ? "Watch changed" : "New watch"} "${name.trim()}": every ${w.every_minutes ?? WATCH_DEFAULT_MINUTES} min this command runs on your computer, and a run starts when it prints a line it hasn't before: ${w.command ?? ""}`);
  }
  if (c.status && c.status !== g.status) lines.push(c.status === "paused" ? "Pause the goal" : "Resume the goal");
  return lines;
}
function holdUntilText(until, now) {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
function runTokens(run) {
  const t = run.tokens ?? 0;
  if (t <= 0) return "";
  return `${t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1e3 ? `${Math.round(t / 1e3)}k` : t} tokens`;
}
function runCost(run) {
  const parts = [];
  const tokens = runTokens(run);
  if (tokens) parts.push(tokens);
  if (run.endedAt) {
    const s = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1e3));
    parts.push(s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`);
  }
  return parts.join(" · ");
}
function planModeBlocked(message) {
  return /needs a person's approval/i.test(message);
}

// state.ts
import { atom, read, update } from "claude-code";
var PANE = "quarterdeck-goals";
var snapshot = atom({ plugin: "quarterdeck-goals", key: "snapshot" }, EMPTY, { shape: "snapshot-5" });
var rejecting = atom({ plugin: "quarterdeck-goals", key: "rejecting" }, null);
var addingTo = atom({ plugin: "quarterdeck-goals", key: "addingTo" }, null);
var askingAbout = atom({ plugin: "quarterdeck-goals", key: "askingAbout" }, null);
var discussing = atom({ plugin: "quarterdeck-goals", key: "discussing" }, null);
var editingTodo = atom({ plugin: "quarterdeck-goals", key: "editingTodo" }, null);
var busy = atom({ plugin: "quarterdeck-goals", key: "busy" }, null);
var notice = atom({ plugin: "quarterdeck-goals", key: "notice" }, null);
var expanded = atom({ plugin: "quarterdeck-goals", key: "expanded" }, []);
var confirm = atom({ plugin: "quarterdeck-goals", key: "confirm" }, null);
var activeRun = atom({ plugin: "quarterdeck-goals", key: "activeRun" }, null);
var runs = atom({ plugin: "quarterdeck-goals", key: "runs" }, {});
var guardMissing = atom({ plugin: "quarterdeck-goals", key: "guardMissing" }, false);
var todos = atom({ plugin: "quarterdeck-goals", key: "todos" }, null);
var phone = atom({ plugin: "quarterdeck-goals", key: "phone" }, "unknown");
async function getPhone($) {
  return read($, phone);
}
async function setPhone($, value) {
  if (await read($, phone) !== value) await update($, phone, () => value);
}
async function getSnapshot($) {
  return read($, snapshot);
}
async function setSnapshot($, value) {
  await update($, snapshot, () => value);
}
async function getRejecting($) {
  return read($, rejecting);
}
async function setRejecting($, value) {
  await update($, rejecting, () => value);
}
async function getBusy($) {
  return read($, busy);
}
async function setBusy($, value) {
  await update($, busy, () => value);
}
async function getNotice($) {
  return read($, notice);
}
async function setNotice($, value) {
  await update($, notice, () => value);
}
async function getExpanded($) {
  return read($, expanded);
}
async function toggleExpanded($, goalId) {
  await update($, expanded, (ids) => ids.includes(goalId) ? ids.filter((id) => id !== goalId) : [...ids, goalId]);
}
async function getConfirm($) {
  return read($, confirm);
}
async function setConfirm($, value) {
  await update($, confirm, () => value);
}
async function getActiveRun($) {
  return read($, activeRun);
}
async function setActiveRun($, value) {
  await update($, activeRun, () => value);
}
async function getGuardMissing($) {
  return read($, guardMissing);
}
async function setGuardMissing($, value) {
  if (await read($, guardMissing) !== value) await update($, guardMissing, () => value);
}
async function getRuns($) {
  return read($, runs);
}
async function addRun($, agentId, entry) {
  await update($, runs, (all) => ({ ...all, [agentId]: entry }));
}
async function removeRun($, agentId) {
  await update($, runs, (all) => {
    const { [agentId]: _gone, ...rest } = all;
    return rest;
  });
}
async function getTodos($) {
  return read($, todos);
}
async function setTodos($, value) {
  await update($, todos, () => value);
}
async function getAddingTo($) {
  return read($, addingTo);
}
async function setAddingTo($, value) {
  await update($, addingTo, () => value);
}
async function getAskingAbout($) {
  return read($, askingAbout);
}
async function setAskingAbout($, value) {
  await update($, askingAbout, () => value);
}
async function getDiscussing($) {
  return read($, discussing);
}
async function setDiscussing($, value) {
  await update($, discussing, () => value);
}
async function getEditingTodo($) {
  return read($, editingTodo);
}
async function setEditingTodo($, value) {
  await update($, editingTodo, () => value);
}

// alerts.ts
var NOTIFY_GAP_MS = 6e4;
var PUSH_MAX = 200;
var IDLE_MS = 5 * 6e4;
var ACTIVE_KEY = "lastActive";
var seen = null;
var lastNotified = /* @__PURE__ */ new Map();
var LAST_ALERT_KEY = "lastAlert";
async function readLastAlert($) {
  try {
    const v = await $.store.get(LAST_ALERT_KEY);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
async function markActive($, at) {
  try {
    await $.store.set(ACTIVE_KEY, at);
  } catch {
  }
}
async function isIdle($, now) {
  try {
    const v = await $.store.get(ACTIVE_KEY);
    return typeof v !== "number" || now - v >= IDLE_MS;
  } catch {
    return true;
  }
}
async function readLastPoll($) {
  try {
    const v = await $.store.get("lastPoll");
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}
async function savePoll($, at) {
  try {
    await $.store.set("lastPoll", at);
  } catch {
  }
}
async function saveAlert($, record) {
  try {
    await $.store.set(LAST_ALERT_KEY, record);
  } catch {
  }
}
var SEEN_KEY = "alertSeen";
async function loadSeen($) {
  try {
    const v = await $.store.get(SEEN_KEY);
    return v && Array.isArray(v.items) && Array.isArray(v.failures) ? v : null;
  } catch {
    return null;
  }
}
async function saveSeen($, value) {
  try {
    await $.store.set(SEEN_KEY, value);
  } catch {
  }
}
async function trace($, line) {
  try {
    const prev = await $.store.get("alertTrace") ?? [];
    await $.store.set("alertTrace", [...prev, line].slice(-6));
  } catch {
  }
}
async function readTrace($) {
  try {
    return await $.store.get("alertTrace") ?? [];
  } catch {
    return [];
  }
}
function resetAlerts() {
  seen = null;
  lastNotified.clear();
}
async function announce($, goals, now) {
  const before = seen ? "memory" : "store";
  if (!seen) seen = await loadSeen($);
  const found = diffAlerts(seen, goals);
  await trace($, `${new Date(now).toISOString()} seen from ${before}${seen ? ` (${seen.items.length} items)` : " (none: first look)"}, now ${found.seen.items.length} waiting, new ${found.proposals.length}`);
  seen = found.seen;
  await saveSeen($, seen);
  const level = settings.alerts;
  const proposals = level === "all" || level === "proposals" ? found.proposals : [];
  const failures2 = level === "all" || level === "failures" ? found.failures : [];
  const lines = [
    ...proposals.length === 1 ? [`${proposals[0].goal.name}: "${proposals[0].item.title}" needs you`] : proposals.length > 1 ? [`${proposals.length} new proposals need you`] : [],
    ...failures2.map((f) => `${f.goal.name}: run failed${f.run.summary ? ` — ${f.run.summary}` : ""}`)
  ];
  if (lines.length === 0) return;
  for (const line of lines) $.ui.toast(`Quarterdeck · ${line}`);
  const record = { at: now, text: lines.join("; "), notify: "not sent (os_notifications off)", push: "not sent (phone_push and phone_relay off)" };
  if (!settings.osNotifications && !settings.phonePush && !settings.phoneRelay) {
    await saveAlert($, record);
    return;
  }
  const goalIds = [.../* @__PURE__ */ new Set([...proposals.map((p) => p.goal.id), ...failures2.map((f) => f.goal.id)])];
  const due = goalIds.filter((id) => now - (lastNotified.get(id) ?? -Infinity) >= NOTIFY_GAP_MS);
  if (due.length === 0) {
    record.notify = record.push = "not sent (one a minute per goal)";
    await saveAlert($, record);
    return;
  }
  for (const id of due) lastNotified.set(id, now);
  if (settings.osNotifications) {
    try {
      const r = await $.ui.notify(lines.join("\n"), { title: "Quarterdeck" });
      record.notify = r.isSent ? `sent (${r.channel})` : `not sent (${r.reason})`;
    } catch (err) {
      record.notify = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const message = phoneText(proposals, failures2);
  if (settings.phonePush) record.push = await pushToPhone($, message);
  else if (settings.phoneRelay) record.push = await relayToPhone($, message, now);
  await saveAlert($, record);
}
function phoneText(proposals, failures2) {
  const parts = [];
  if (proposals.length === 1) {
    const { goal, item } = proposals[0];
    parts.push(item.asksPerson ? `${goal.name} needs you: "${item.title}". Reply with your answer in Claude.` : `${goal.name} asks: "${item.title}". Reply "approve" or "reject, because ..." in Claude.`);
  } else if (proposals.length > 1) {
    parts.push(`${proposals.length} proposals need you. Reply "what needs me?" in Claude.`);
  }
  if (failures2.length === 1) parts.push(`${failures2[0].goal.name}: run failed.`);
  else if (failures2.length > 1) parts.push(`${failures2.length} goal runs failed.`);
  const text = `Quarterdeck: ${parts.join(" ")}`;
  if (text.length <= PUSH_MAX) return text;
  const over = text.length - PUSH_MAX + 1;
  return proposals.length === 1 ? text.replace(`"${proposals[0].item.title}"`, `"${proposals[0].item.title.slice(0, Math.max(10, proposals[0].item.title.length - over))}…"`).slice(0, PUSH_MAX) : text.slice(0, PUSH_MAX);
}
function relayPrompt(message) {
  return `[Quarterdeck alert, sent automatically while you're away] Send me this phone notification with the PushNotification tool (status "proactive"), word for word, then end your turn without doing anything else:
${message}`;
}
async function callPush($, message) {
  const r = await $.tool.call({ tool: "PushNotification", message, status: "proactive" });
  const res = r.result ?? {};
  return { deny: r.deny, pushSent: res.pushSent, disabledReason: res.disabledReason, raw: r.result ?? r };
}
var REMOTE_COMMAND = "remote-control";
async function whyNotRelay($, message) {
  let answer;
  try {
    answer = await callPush($, message);
  } catch {
    return null;
  }
  if (answer.disabledReason === "no_transport") {
    await setPhone($, "no_transport").catch(() => {
    });
    return `not relayed (Remote Control isn't connected: run /${REMOTE_COMMAND})`;
  }
  if (answer.disabledReason === "config_off") {
    await setPhone($, "config_off").catch(() => {
    });
    return "not relayed (mobile push is off in /config)";
  }
  if (answer.disabledReason === "user_present") return "not relayed (you're at the terminal)";
  if (answer.pushSent === true) await setPhone($, "connected").catch(() => {
  });
  return null;
}
async function relayToPhone($, message, now) {
  const blocked = await whyNotRelay($, message);
  if (blocked) return blocked;
  if (!await isIdle($, now)) return "not relayed (you typed in the last 5 minutes)";
  try {
    await $.prompt.submit({ text: relayPrompt(message) });
    return "relayed to Claude to push";
  } catch (err) {
    return `relay failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
async function pushToPhone($, message) {
  try {
    const r = await callPush($, message);
    if (r.deny !== void 0) return `refused: ${r.deny}`;
    if (r.pushSent === true) return "sent to the phone";
    if (r.disabledReason) return `not sent (${r.disabledReason})`;
    return `answered: ${JSON.stringify(r.raw).slice(0, 200)}`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
async function markRemote($) {
  if (await getPhone($).catch(() => "unknown") !== "config_off") await setPhone($, "connected").catch(() => {
  });
}
async function connectRemote($) {
  try {
    const commands = await $.command.list();
    if (!commands.some((c) => c.name === REMOTE_COMMAND)) return `This session has no /${REMOTE_COMMAND} command: phone alerts need Remote Control.`;
    await $.command.run({ command: REMOTE_COMMAND });
    await setPhone($, "unknown");
    return null;
  } catch (err) {
    return `Couldn't start Remote Control (${err instanceof Error ? err.message : String(err)}): type /${REMOTE_COMMAND}.`;
  }
}
async function phoneHint($) {
  if (settings.alerts === "off" || !settings.phoneRelay && !settings.phonePush) return "";
  const state = await getPhone($).catch(() => "unknown");
  if (state === "connected") return "";
  if (state === "config_off") return " To hear on your phone when it needs you, turn mobile push on in /config.";
  return ` To hear on your phone when it needs you, connect Remote Control in this session (/${REMOTE_COMMAND}).`;
}
function showStatus($, s) {
  $.ui.status(statusText(s));
}

// runner.ts
var RUNNER_AGENT = "quarterdeck-goals:goal-runner";
var TICK_MS = 3e4;
var ENDED = /* @__PURE__ */ new Set(["completed", "failed", "killed"]);
var GUARD_TOOL = "mcp__quarterdeck-guard__status";
var GUARD_MISSING = "Goal runs are paused: the quarterdeck-guard plugin (it keeps runs within their goal) isn't loaded. Run /reload-plugins; if this stays, install it with: claude plugin install quarterdeck-guard@quarterdeck";
var GUARD_GRACE_MS = 1e4;
var GUARD_RECHECK_MS = 2e3;
var HUMAN_ONLY_TOOLS = serverToolNames(
  "goals_tick",
  "decide_item",
  "cancel_run",
  "set_goal_status",
  "attach_agent",
  "fail_run",
  "guard_check",
  "create_goal",
  "delete_goal",
  "delete_memory",
  "set_schedule",
  "update_goal",
  "report_run_end",
  "watch_report"
);
var RUN_AGENT_DENIED_TOOLS = [...HUMAN_ONLY_TOOLS, ...serverToolNames("run_goal")];
var RUNNER_PROMPT = `You carry out one run of a Quarterdeck persistent goal: a standing objective that is never finished. You start with no memory; the goal brief has everything. Work inside the goal's autonomy: never take an action whose category is "propose" or "off" unless the brief shows an approved item for it. Keep within the time you are given, and always finish with end_run. Pass run_scope, set to your run id, on every Quarterdeck tool call (get_goal_brief, add_item, end_run and the rest). Your final message is shown to nobody but Quarterdeck, so keep it to one line.`;
async function registerRunnerAgent($) {
  await $.agent.register({
    name: "goal-runner",
    description: "Runs one Quarterdeck goal run. Started by the quarterdeck-goals plugin only.",
    prompt: RUNNER_PROMPT,
    // guard_check stays callable: the plugin calls it inside the run's loop (the guard refuses it to the agent)
    disallowedTools: [
      ...RUN_AGENT_DENIED_TOOLS.filter((t) => !t.endsWith("__guard_check")),
      "mcp__quarterdeck-goals__approve_item",
      "mcp__quarterdeck-goals__reject_item",
      "mcp__quarterdeck-goals__answer_item",
      "mcp__quarterdeck-goals__run_goal",
      "mcp__quarterdeck-goals__set_schedule",
      "mcp__quarterdeck-goals__update_goal"
    ],
    background: true
  });
}
var timer = null;
var ticking = null;
var guardMissingSince = null;
var recheck = null;
function startRunner($) {
  timer?.cancel();
  recheck?.cancel();
  recheck = null;
  guardMissingSince = null;
  timer = $.clock.every(TICK_MS, () => void runPass($));
  void runPass($);
}
async function stopRunner($) {
  timer?.cancel();
  timer = null;
  recheck?.cancel();
  recheck = null;
  await releaseLease($, await $.session.id()).catch(() => {
  });
}
function kick($) {
  return runPass($);
}
function runPass($) {
  ticking ??= pass($).catch(() => {
  }).finally(() => {
    ticking = null;
  });
  return ticking;
}
async function pass($) {
  await reconcile($);
  const guarded = (await $.tool.list()).some((t) => t.name === GUARD_TOOL);
  recheck?.cancel();
  recheck = null;
  if (guarded) guardMissingSince = null;
  else {
    const now = await $.clock.now();
    guardMissingSince ??= now;
    if (now - guardMissingSince < GUARD_GRACE_MS) recheck = $.clock.after(GUARD_RECHECK_MS, () => void runPass($));
  }
  await setGuardMissing($, guardMissingSince !== null && await $.clock.now() - guardMissingSince >= GUARD_GRACE_MS);
  if (guarded && await getNotice($) === GUARD_MISSING) await setNotice($, null);
  if (!guarded) return;
  const runs2 = await getRuns($);
  const { claimed, toolWatches } = await tick($, await $.session.id(), Object.values(runs2).map((r) => r.runId));
  for (const run of claimed) await start($, run);
  let fresh = false;
  for (const watch of toolWatches) fresh = await checkToolWatch($, watch) || fresh;
  if (fresh) {
    const again = await tick($, await $.session.id(), Object.values(await getRuns($)).map((r) => r.runId), false);
    for (const run of again.claimed) await start($, run);
  }
}
var WATCH_CALL_MS = 3e4;
var WATCH_TEXT_MAX = 6e4;
async function checkToolWatch($, watch) {
  let report;
  try {
    const answer = await Promise.race([
      $.tool.call({ tool: watch.tool, ...watch.input }),
      $.clock.sleep(WATCH_CALL_MS).then(() => "timeout")
    ]);
    if (answer === "timeout") report = { error: `${watch.tool} didn't answer within ${WATCH_CALL_MS / 1e3} s` };
    else if (answer.deny !== void 0) report = { error: `Claude Code refused the call: ${answer.deny}` };
    else if (answer.isError === true) report = { error: resultText(answer).slice(0, 500) };
    else report = { text: resultText(answer).slice(0, WATCH_TEXT_MAX) };
  } catch (err) {
    report = { error: err instanceof Error ? err.message : String(err) };
  }
  return reportWatch($, watch.watch_id, report).then((r) => r.queued_run !== null).catch(() => false);
}
async function start($, run) {
  let agentId;
  let why = "no agent was started";
  const description = `Goal: ${run.name} (${run.run_id})`;
  try {
    const r = await $.agent.spawn({ subagentType: RUNNER_AGENT, prompt: run.prompt, description, cwd: run.working_dir });
    agentId = r.agentId;
    if ("deny" in r && typeof r.deny === "string") why = r.deny;
    else if (!agentId) agentId = (await $.agent.list()).find((a) => a.description === description && !ENDED.has(a.status))?.id;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (!agentId) {
    await failRun($, run.run_id, "failed", `Couldn't start the run's agent: ${why}`).catch(() => {
    });
    return;
  }
  const now = await $.clock.now();
  const entry = {
    runId: run.run_id,
    goalId: run.goal_id,
    name: run.name,
    startedAt: now,
    deadline: now + run.max_run_minutes * 6e4,
    maxMinutes: run.max_run_minutes
  };
  await addRun($, agentId, entry);
  await attachAgent($, run.run_id, agentId).catch(() => {
  });
}
async function reconcile($) {
  const runs2 = await getRuns($);
  const ids = Object.keys(runs2);
  if (ids.length === 0) return false;
  const agents = await $.agent.list();
  const now = await $.clock.now();
  const snapshot2 = await getSnapshot($);
  let ended = false;
  for (const agentId of ids) {
    const run = runs2[agentId];
    const agent = agents.find((a) => a.id === agentId);
    const card = snapshot2.reachable && snapshot2.fetchedAt > run.startedAt + 1e4 ? snapshot2.goals.find((g) => g.id === run.goalId) : void 0;
    const endedElsewhere = card !== void 0 && card.openRun?.id !== run.runId;
    if (endedElsewhere) {
      await stopAgent($, agentId);
    } else if (now >= run.deadline) {
      await stopAgent($, agentId);
      await failRun($, run.runId, "timed_out", `Run exceeded its ${run.maxMinutes}-minute limit`).catch(() => {
      });
    } else if (!agent || ENDED.has(agent.status)) {
      await failRun($, run.runId, "failed", "The agent ended without calling end_run").catch(() => {
      });
    } else {
      continue;
    }
    await removeRun($, agentId);
    ended = true;
  }
  return ended;
}
async function stopAgent($, agentId) {
  await $.tool.call({ tool: "TaskStop", task_id: agentId }).catch(() => {
  });
}
async function cancelRun($, goalId) {
  const { agentId } = await cancelRunRecord($, goalId);
  const runs2 = await getRuns($);
  const mine = agentId && runs2[agentId] ? agentId : Object.keys(runs2).find((id) => runs2[id].goalId === goalId);
  if (mine) {
    await stopAgent($, mine);
    await removeRun($, mine);
  }
}

// schedule.ts
var SYSTEM = `You choose how often a standing goal for an AI agent should run. Most goals are ongoing work (keeping, maintaining, monitoring, triaging, checking, tidying) and should run on a schedule; pick a one-off only when the goal is clearly a single task that is finished once done (install, set up, migrate, fix this one thing).
Answer with JSON only: {"choice": "hourly" | "6h" | "daily" | "weekly" | "one-off", "reason": "<one short sentence>"}, adding "title": "<2-5 word name, Title Case>" when the goal has no name yet.
Guide: inboxes, alerts and triage hourly; monitoring and watching every 6 hours; maintaining, keeping current and checking daily; reports, digests and reviews weekly.`;
async function suggestSchedule($, name, objective) {
  let suggestion = null;
  try {
    const prompt = `Goal name: ${name ?? "(none yet: suggest a title)"}
Objective: ${objective}`;
    const r = await $.model.complete({ model: "haiku", system: SYSTEM, prompt, maxTokens: 120, timeoutMs: 15e3 });
    if (r.isAnswered) suggestion = parseSuggestion(r.text);
  } catch {
  }
  suggestion ??= suggestByKeywords(name ?? "", objective);
  return name ? suggestion : { ...suggestion, title: suggestion.title ?? fallbackTitle(objective) };
}
var READ_SYSTEM = `Turn the person's words about how often a recurring task should run into exactly one line of this syntax, and nothing else:
every <N><m|h|d|w>   (optionally followed by " between HH:MM-HH:MM")
cron <minute> <hour> <day of month> <month> <day of week>   (local time)
off
one-off
Examples: "every other week" -> every 2w; "twice a day" -> every 12h; "weekdays at 9" -> cron 0 9 * * 1-5; "first of the month" -> cron 0 9 1 * *; "never" -> off.
If the words don't describe a schedule, answer: unclear`;
async function readSchedule($, text) {
  const strict = parseSchedule(text);
  if (!("error" in strict) || !text.trim()) return strict;
  try {
    const r = await $.model.complete({ model: "haiku", system: READ_SYSTEM, prompt: text.trim(), maxTokens: 30, timeoutMs: 15e3 });
    if (r.isAnswered) {
      const line = r.text.trim().split("\n")[0].replace(/^["'`]|["'`]$/g, "").trim();
      const read2 = parseSchedule(line);
      if (!("error" in read2)) return { ...read2, interpreted: line };
    }
  } catch {
  }
  return strict;
}
async function askSchedule($, goalName, suggestion) {
  const suggested = SCHEDULE_CHOICES.find((c) => c.key === suggestion.choice);
  const read2 = await ask($, goalName, suggestion, null);
  if (read2 && "error" in read2) $.ui.toast(`Couldn't read "${read2.answer}", so it runs ${suggested.label.toLowerCase()}. ${read2.error} Change it with Reschedule.`);
  return read2 && "choice" in read2 ? read2.choice : suggested;
}
async function ask($, goalName, suggestion, current) {
  const suggested = SCHEDULE_CHOICES.find((c) => c.key === suggestion.choice);
  const now = current ? `Now: ${scheduleLabel(current)}. ` : "";
  let answer = null;
  try {
    answer = await $.ui.ask(
      `${now}How often should "${goalName}" run? Suggested: ${suggested.label.toLowerCase()} (${suggestion.reason}). Or type your own: 12h, 30d, weekly, cron 0 9 * * 1-5, or off.`,
      choiceOptions(suggestion.choice)
    );
  } catch {
    answer = null;
  }
  const read2 = readAnswer(answer);
  if (!read2 || !("error" in read2)) return read2;
  const typed = await readSchedule($, answer);
  if ("error" in typed) return { ...read2, answer };
  return { choice: { key: "custom", label: typed.oneOff ? "one-off" : scheduleLabel(typed.schedule), schedule: typed.schedule, oneOff: typed.oneOff ?? false, read: `"${answer}" as ${typed.interpreted}` } };
}
async function rescheduleGoal($, goal) {
  const read2 = await ask($, goal.name, await suggestSchedule($, goal.name, goal.objective), goal.schedule);
  if (!read2 || "error" in read2) {
    $.ui.toast(read2 ? `Couldn't read "${read2.answer}": ${read2.error} The schedule is unchanged.` : `${goal.name}: schedule unchanged.`);
    return;
  }
  const choice = read2.choice;
  await setSchedule($, goal.id, choice.schedule, choice.oneOff);
  $.ui.toast(`${goal.name} now runs ${choice.oneOff ? "once" : scheduleLabel(choice.schedule)}${choice.read ? ` (read ${choice.read})` : ""}.`);
}
async function chooseSchedule($, goal) {
  const choice = await askSchedule($, goal.name, await suggestSchedule($, goal.name, goal.objective));
  await setSchedule($, goal.id, choice.schedule, choice.oneOff);
  return choice;
}

// chat.ts
async function sendToChat($, prompt, aside) {
  const { text: draft } = await $.prompt.read();
  if (draft.trim()) {
    const filled = await $.prompt.fill({ text: ` (${aside})`, mode: "append" });
    if (filled.isFilled) {
      $.ui.toast("Added to your prompt: press Enter to send it.");
      return "added";
    }
  }
  await $.prompt.submit({ text: prompt });
  return "sent";
}

// sync.ts
var FAST_MS = 5e3;
var MAX_BACKOFF_MS = 6e4;
var inFlight = null;
var failures = 0;
var timer2 = null;
function refresh($) {
  inFlight ??= load($).then(async (s) => {
    await refreshTodos($);
    return s;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
async function load($) {
  const previous = await getSnapshot($);
  const now = await $.clock.now();
  let next;
  try {
    const res = await fetchOverview($, previous.reachable ? previous.etag : null, await getExpanded($)).catch((err) => {
      if (err instanceof Error && /too large/.test(err.message)) return fetchOverview($, null, []);
      throw err;
    });
    failures = 0;
    if (!res.changed) {
      if (previous.reachable) return previous;
      next = { ...previous, reachable: true, error: null, fetchedAt: now };
    } else {
      const goals = res.goals.map(toCard);
      next = { reachable: true, error: null, goals, fetchedAt: now, etag: res.etag, hold: res.hold, ...res.outdated ? { outdated: true } : {}, ...res.standing ? { standing: true } : {}, ...res.update ? { update: res.update } : {} };
      await announce($, goals, now);
    }
  } catch (err) {
    failures += 1;
    next = { ...previous, reachable: false, error: err instanceof Error ? err.message : String(err), etag: null };
  }
  await setSnapshot($, next);
  showStatus($, next);
  return next;
}
function nextDelay(s) {
  const base = settings.pollSeconds * 1e3;
  if (!s.reachable) return Math.min(base * 2 ** Math.max(failures - 1, 0), Math.max(MAX_BACKOFF_MS, base));
  if (s.goals.some((g) => g.openRun)) return Math.min(FAST_MS, base);
  return base;
}
function startPolling($, first) {
  timer2?.cancel();
  timer2 = $.clock.after(nextDelay(first), () => {
    void $.clock.now().then((t) => savePoll($, t));
    void refresh($).then((s) => startPolling($, s));
  });
}
function stopPolling() {
  timer2?.cancel();
  timer2 = null;
}
async function act($, key, label, run) {
  await setBusy($, key);
  let ok = false;
  try {
    await run();
    await setNotice($, null);
    ok = true;
    await kick($);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setNotice($, planModeBlocked(message) ? `Couldn't ${label}: plan mode is on, and Claude Code doesn't let Quarterdeck change anything until it ends (Shift+Tab to leave it).` : `Couldn't ${label}: ${message}`);
  }
  await setBusy($, null);
  await refresh($);
  return ok;
}
async function refreshTodos($) {
  try {
    const dir = await $.session.root();
    await setTodos($, { dir, lists: await fetchTodos($, dir) });
  } catch {
  }
}

// todos.ts
var isDone = (i) => i.status === "completed" || i.status === "abandoned";
function describeTodos(lists, opts = {}) {
  if (lists.length === 0) return "No to-do lists for this project yet. Add one with /todo <text> (or the add_todo tool).";
  return lists.map((l) => {
    const items = l.items.filter((i) => opts.withDone || !isDone(i));
    const lines = items.map((i) => `${"  ".repeat(i.depth)}- [${isDone(i) ? "x" : i.status === "active" ? "~" : " "}] ${i.id}: ${i.text}${i.notes ? ` (${i.notes})` : ""}`);
    return [`## ${l.name} (list ${l.id}): ${l.open} open, ${l.done} done`, ...lines.length ? lines : ["  nothing open"]].join("\n");
  }).join("\n\n");
}
function findTodo(lists, itemId, listId) {
  const matches = lists.filter((l) => !listId || l.id === listId || l.name.toLowerCase() === listId.toLowerCase()).flatMap((l) => l.items.filter((i) => i.id === itemId).map((item) => ({ list: l, item })));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return { error: `No to-do ${itemId}${listId ? ` in ${listId}` : ""}.` };
  return { error: `More than one list has a to-do ${itemId}: ${matches.map((m) => m.list.name).join(", ")}. Say which list.` };
}
async function todoCommand($, args) {
  const dir = await $.session.root();
  const text = args.trim();
  if (!text) {
    const lists = await fetchTodos($, dir);
    return describeTodos(lists);
  }
  const done = /^(done|undo)\s+(\S+)$/i.exec(text);
  if (done) {
    const found = findTodo(await fetchTodos($, dir), done[2]);
    if ("error" in found) return found.error;
    const status = done[1].toLowerCase() === "done" ? "completed" : "pending";
    await setTodo($, found.list.id, found.item.id, status);
    await refresh($);
    return `${status === "completed" ? "Ticked off" : "Back on the list"}: ${found.item.text}`;
  }
  const r = await addTodo($, { dir, text });
  await refreshTodos($);
  return `Added to your to-do list (${r.item_id}): ${text}`;
}
function todoPrompt(list, item, mode, question, opts = {}) {
  if (mode === "ask" && question?.trim()) {
    return `About to-do ${item.id} on my list "${list.name}":

${item.text}${item.notes ? `

(Notes: ${item.notes})` : ""}

My question: ${question.trim()}

Answer it. Don't change anything or start work on it.`;
  }
  if (mode === "ask") {
    return `What do you think of to-do ${item.id} on my list "${list.name}"?

${item.text}${item.notes ? `

(Notes: ${item.notes})` : ""}

Give me your opinion and the trade-offs. Don't change anything or start work on it.`;
  }
  const from = `From my to-do list "${list.name}", item ${item.id}:

${item.text}${item.notes ? `

(Notes: ${item.notes})` : ""}`;
  const end = `When it's done, tick it off with complete_todo (item ${item.id}${list.name !== "To do" ? `, list "${list.name}"` : ""}).`;
  const plan = opts.planModeOn ? "Plan this before changing anything (plan mode should be on; if it isn't, enter it first)" : "Enter plan mode and plan this before changing anything";
  return mode === "plan" ? `${from}

${plan}: explore what it involves, ask me what you need to, and present the plan for me to review. ${end}` : `${from}

Let's work on this now. Ask me if anything is unclear. ${end}`;
}
async function enterPlanMode($) {
  try {
    const commands = await $.command.list();
    if (!commands.some((c) => c.name === "plan" && c.source === "builtin")) return false;
    await $.command.run({ command: "plan" });
    return true;
  } catch {
    return false;
  }
}
async function workOnTodo($, list, item, mode) {
  try {
    await setTodo($, list.id, item.id, "active", mode === "plan" ? "Planning it in the conversation" : "Working on it in the conversation");
  } catch {
  }
  const planModeOn = mode === "plan" && await enterPlanMode($);
  await $.prompt.submit({ text: todoPrompt(list, item, mode, void 0, { planModeOn }) });
}
async function askAboutTodo($, list, item, question) {
  await $.prompt.submit({ text: todoPrompt(list, item, "ask", question) });
}
async function toggleTodo($, list, item) {
  const ticking2 = !isDone(item);
  const ok = await act($, `todo:${list.id}/${item.id}`, "update the to-do", () => setTodo($, list.id, item.id, ticking2 ? "completed" : "pending"));
  if (ok) $.ui.toast(ticking2 ? `Ticked off ${item.id}. To undo, open "done" under ${list.name} and press it.` : `${item.id} is back on ${list.name}.`);
  return ok;
}
function addFromPane($, dir, list, text) {
  return act($, `todo-add:${list.id}`, "add the to-do", async () => void await addTodo($, { dir, text, listId: list.id }));
}
async function askFromPane($, list, item, question) {
  const ok = await act($, `todo-ask:${list.id}/${item.id}`, "ask about it", () => askAboutTodo($, list, item, question));
  if (ok) await setAskingAbout($, null);
  return ok;
}
async function editFromPane($, list, item, text) {
  const wording = text.trim();
  if (!wording || wording === item.text) {
    await setEditingTodo($, null);
    return true;
  }
  const ok = await act($, `todo-edit:${list.id}/${item.id}`, "change the to-do", () => editTodo($, list.id, item.id, { text: wording, by: "human" }));
  if (ok) {
    await setEditingTodo($, null);
    $.ui.toast(`Changed ${item.id}. It said: ${clip(item.text, 80)}`);
  }
  return ok;
}
function workFromPane($, list, item, mode) {
  return act($, `todo-${mode}:${list.id}/${item.id}`, mode === "plan" ? "plan it" : "start it", () => workOnTodo($, list, item, mode));
}

// pane.tsx
var ACTION_COLOR = "suggestion";
function action($, e, p) {
  const { Button, Text } = $.ui.resolve(e);
  return <Button key={p.key} plain label={p.label} hotkey={p.hotkey} onPress={p.onPress}>
      <Text color={ACTION_COLOR}>{p.label}</Text>
    </Button>;
}
function canRun(g) {
  return g.status === "active" && !g.openRun;
}
async function renderPane($, e) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const s = await getSnapshot($);
  const message = await getNotice($);
  const guardMissing2 = await getGuardMissing($);
  const todos2 = await getTodos($);
  const addingTo2 = await getAddingTo($);
  const askingAbout2 = await getAskingAbout($);
  const editing = await getEditingTodo($);
  const phone2 = await getPhone($);
  if (!s.reachable && s.fetchedAt === 0 && !s.error) {
    return <Box flexDirection="column">
        <Text dimColor>Reading your goals…</Text>
        <Button key="retry" label="Refresh" hotkey="g" onPress={() => void refresh($)} />
      </Box>;
  }
  if (!s.reachable && s.goals.length === 0) {
    return <Box flexDirection="column">
        <Text>Quarterdeck isn't connected.</Text>
        {s.error === NOT_LOADED ? <Text dimColor>{NOT_LOADED}</Text> : <Box flexDirection="column">
              <Text dimColor>The quarterdeck MCP server comes with this plugin: check it in /mcp, or run /reload-plugins.</Text>
              {s.error && <Text dimColor>{s.error}</Text>}
            </Box>}
        <Button key="retry" label="Retry" hotkey="g" onPress={() => void refresh($)} />
      </Box>;
  }
  const current = s.goals.filter((g) => g.status !== "retired");
  const done = s.goals.filter((g) => g.status === "retired");
  const firstWithProposal = current.find((g) => g.needsYou.length > 0);
  const shown = await getExpanded($);
  const oneLine = current.map((g) => isQuiet(g) && !shown.includes(g.id));
  const view = {
    now: await $.clock.now(),
    columns: e.props.bodyColumns,
    base: await baseUrl($),
    doing: await getBusy($),
    open: await getRejecting($),
    shown,
    pending: await getConfirm($),
    discussing: await getDiscussing($),
    first: firstWithProposal ? `${firstWithProposal.id}/${firstWithProposal.needsYou[0].id}` : null,
    // Only a full card has Run now to carry the hotkey
    runnable: current.find((g, i) => canRun(g) && !oneLine[i])?.id ?? null
  };
  return <Box flexDirection="column">
      {guardMissing2 && <Text color="yellow">{GUARD_MISSING}</Text>}
      {s.outdated && <Text color="yellow">Quarterdeck was updated in another session: run /reload-plugins here to use the new version (this session won't start goal runs until then).</Text>}
      {s.update && <Box>
          <Text color="yellow">Quarterdeck {s.update.latest} is available (you have {s.update.installed}). </Text>
          {action($, e, { key: "update-install", label: view.doing === "update-install" ? "Sending…" : "Ask Claude to install it", onPress: () => void askToUpdate($, s.update) })}
        </Box>}
      {s.standing && <Text dimColor>The standing session is starting goal runs, so they also run with this window closed.</Text>}
      {s.hold && <Text color="yellow">Goal runs are on hold until {holdUntilText(s.hold.until, view.now)}: the usage limit is reached. Due runs start after that.</Text>}
      {phone2 === "no_transport" && <Box>
          <Text color="yellow">Alerts can't reach your phone: Remote Control isn't connected in this session. </Text>
          {action($, e, { key: "phone-connect", label: view.doing === "phone-connect" ? "Connecting…" : "Connect", onPress: () => void act($, "phone-connect", "connect Remote Control", async () => {
    const failed = await connectRemote($);
    if (failed) throw new Error(failed);
  }) })}
        </Box>}
      {phone2 === "config_off" && <Text color="yellow">Alerts can't reach your phone: mobile push is off. Turn it on in /config.</Text>}
      {!s.reachable && <Text color="yellow">Offline — showing the last read ({ago(new Date(s.fetchedAt).toISOString(), view.now)}).</Text>}
      {current.length === 0 && done.length === 0 && !todos2?.lists.length && welcome($, e)}
      {current.length === 0 && (done.length > 0 || !!todos2?.lists.length) && <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>No goals yet.</Text>
          <Text dimColor>Create one with /goal-new &lt;objective&gt;; /goal-new alone offers ready-made ones.</Text>
        </Box>}
      {current.map((g, i) => oneLine[i] ? quietLine($, e, view, g, i, oneLine[i + 1] ? 0 : 1) : goalCard($, e, view, g, i))}
      {todos2 && todos2.lists.length > 0 && todoSection($, e, view, todos2, addingTo2, askingAbout2, editing)}
      {done.length > 0 && doneSection($, e, view, done)}
      {message && <Text color="red">{message}</Text>}
      <Box>
        <Text dimColor>Last change {ago(new Date(s.fetchedAt).toISOString(), view.now)} </Text>
        {action($, e, { key: "refresh", label: "Refresh", hotkey: "g", onPress: () => void refresh($) })}
      </Box>
    </Box>;
}
function welcome($, e) {
  const { Box, Text } = $.ui.resolve(e);
  return <Box key="welcome" flexDirection="column" marginBottom={1}>
      <Text>Welcome to Quarterdeck.</Text>
      <Text dimColor>A goal is a standing job Claude keeps doing in the background, like "keep my inbox under 20 unread". Each run reports here, and anything it wants to do waits for your OK.</Text>
      <Text> </Text>
      <Text dimColor>/goal-new                pick a ready-made goal</Text>
      <Text dimColor>/goal-new &lt;objective&gt;    start your own (it suggests a schedule)</Text>
      <Text dimColor>/todo &lt;text&gt;             add to this project's to-do list, shown here</Text>
    </Box>;
}
function quietLine($, e, view, g, index, gap) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const run = lastRun(g);
  const facts = [
    g.status === "active" ? "" : ` · ${g.status}`,
    // What the last run used; when it ran only if its tokens weren't recorded
    ` · ${run ? runTokens(run) || `ran ${ago(run.endedAt ?? run.startedAt, view.now)}` : "no runs yet"}`,
    nextRunText(g, view.now),
    g.openItemCount > 0 ? ` · ${g.openItemCount} open` : ""
  ].join("");
  const room = view.columns - 5 - [...g.name].length;
  return <Box key={g.id} marginBottom={gap}>
      <Button key={`toggle-${g.id}`} plain label={`▸ ${g.name}`} hotkey={index < 9 ? String(index + 1) : void 0} onPress={() => void toggleExpanded($, g.id).then(() => refresh($))} />
      {room >= 8 && <Text dimColor>{clip(facts, room)}</Text>}
    </Box>;
}
function goalCard($, e, view, g, index) {
  const { Box, Text, Button, Link } = $.ui.resolve(e);
  const isOpen = view.shown.includes(g.id);
  const run = lastRun(g);
  const toggle = () => void toggleExpanded($, g.id).then(() => refresh($));
  return <Box key={g.id} flexDirection="column" marginBottom={1}>
      <Box>
        <Button key={`toggle-${g.id}`} plain label={`${isOpen ? "▾" : "▸"} ${g.name}`} hotkey={index < 9 ? String(index + 1) : void 0} onPress={toggle} />
        <Text dimColor> {g.status}</Text>
        {g.openRun && <Text color="cyan"> · run {g.openRun.status}</Text>}
      </Box>
      {activityLine($, e, view, g)}
      <Text dimColor>
        {run ? <Text color={isFailed(run.status) ? "red" : void 0}>last run {run.status} {ago(run.endedAt ?? run.startedAt, view.now)}</Text> : "no runs yet"}
        {run && runCost(run) ? ` · ${runCost(run)}` : ""}
        {nextRunText(g, view.now)}
        {g.openItemCount > 0 ? ` · ${g.openItemCount} open` : ""}
      </Text>
      {g.health && <Text>
          <Text color={g.health.passed ? "green" : "red"}>{g.health.passed ? "healthy" : "failing"}</Text>
          {g.health.value !== null ? ` ${g.health.value}` : ""} <Text dimColor>{spark(g.trend)}</Text>
        </Text>}
      {g.watchFailing && <Text color="red">a watch can't check{isOpen ? "" : ": expand the goal to see why"}</Text>}
      {g.needsYou.map((item) => proposalRow($, e, view, g, item))}
      {g.needsYouCount > g.needsYou.length && <Text dimColor>… and {g.needsYouCount - g.needsYou.length} more waiting: expand the goal ({index < 9 ? index + 1 : "its name"}) to see them all</Text>}
      {controls($, e, view, g)}
      {isOpen && details($, e, view, g)}
      {g.suggestions.map((s) => autoSuggestion($, e, view, g, s))}
    </Box>;
}
function autoSuggestion($, e, view, g, s) {
  const { Box, Text, Button, Link } = $.ui.resolve(e);
  const key = `${g.id}-${s.category}`;
  const confirming = view.pending?.kind === "auto" && view.pending.goalId === g.id && view.pending.category === s.category;
  return <Box key={`suggestion-${key}`} flexDirection="column">
      <Text dimColor>Approved every time lately ({s.approvedInARow} in a row): {s.category}</Text>
      {confirming ? <Box flexDirection="column">
          <Text color="yellow">Runs will do {s.category} actions without asking you first. Switch?</Text>
          <Box>
            <Button
    key={`auto-yes-${key}`}
    label={view.doing === `auto:${key}` ? "Switching…" : "Yes, switch"}
    onPress={() => {
      void setConfirm($, null);
      void act($, `auto:${key}`, "switch to auto", async () => void await updateGoal($, g.id, { autonomy: { [s.category]: "auto" } }));
    }}
  />
            <Text dimColor> · </Text>
            {action($, e, { key: `auto-no-${key}`, label: "Keep asking", onPress: () => void setConfirm($, null) })}
          </Box>
        </Box> : <Box>
          {action($, e, { key: `auto-${key}`, label: `Switch ${s.category} to auto`, onPress: () => void setConfirm($, { kind: "auto", goalId: g.id, category: s.category }) })}
          <Text dimColor> · </Text>
          <Link key={`autonomy-${key}`} href={`${view.base}/goals/${encodeURIComponent(g.id)}`} label="open the goal page" />
        </Box>}
    </Box>;
}
function activityLine($, e, view, g) {
  const { Text } = $.ui.resolve(e);
  const { state, text, at } = g.activity;
  if (!text) return null;
  if (state === "running") {
    const age = at ? ` · ${ago(at, view.now)}` : "";
    return <Text key={`activity-${g.id}`}>
        <Text color="cyan">● {clip(text, Math.max(view.columns - 2 - age.length, 10))}</Text>
        <Text dimColor>{age}</Text>
      </Text>;
  }
  return <Text key={`activity-${g.id}`} dimColor>{state === "queued" ? "◌ " : ""}{clip(text, Math.max(view.columns - 2, 10))}</Text>;
}
function proposalRow($, e, view, g, item) {
  const { Box, Text, Button, Input } = $.ui.resolve(e);
  const key = `${g.id}/${item.id}`;
  const isFirst = view.first === key;
  const sendBack = (text) => {
    if (!text.trim()) return;
    void act($, `reject:${key}`, "reject", () => reject($, g.id, item.id, text.trim())).then((ok) => {
      if (ok) void setRejecting($, null);
    });
  };
  const reply = (text) => {
    if (!text.trim()) return;
    void act($, `answer:${key}`, "answer", () => answerItem($, g.id, item.id, text.trim())).then((ok) => {
      if (ok) void setRejecting($, null);
    });
  };
  if (item.asksPerson) {
    return <Box key={key} flexDirection="column" marginTop={1}>
        <Text color="yellow">? {item.title}</Text>
        {view.open === key && Input ? <Box flexDirection="column">
            <Input key={`answer-${key}`} label="Your answer (saved to the goal's memory)" submitLabel="Send" autoFocus onSubmit={reply} />
            {action($, e, { key: `cancel-${key}`, label: "Cancel", onPress: () => void setRejecting($, null) })}
          </Box> : <Box>
            <Button key={`answer-btn-${key}`} label="Answer…" variant="primary" hotkey={isFirst ? "a" : void 0} onPress={() => void setRejecting($, key)} />
            <Text dimColor> · </Text>
            {action($, e, { key: `done-${key}`, label: view.doing === `approve:${key}` ? "Marking…" : "Done", onPress: () => void act($, `approve:${key}`, "mark it done", () => approve($, g.id, item.id)) })}
          </Box>}
      </Box>;
  }
  return <Box key={key} flexDirection="column" marginTop={1}>
      <Text color="yellow">● {item.title}</Text>
      {(item.category || item.summary) && <Text dimColor>
          {"  "}
          {item.category ? `${item.category}: ` : ""}
          {item.summary ?? ""}
        </Text>}
      {view.open === key && Input ? <Box flexDirection="column">
          <Input key={`feedback-${key}`} label="What should change? (saved to the goal's memory)" submitLabel="Send back" autoFocus onSubmit={sendBack} />
          {action($, e, { key: `cancel-${key}`, label: "Cancel", onPress: () => void setRejecting($, null) })}
        </Box> : <Box>
          <Button
    key={`approve-${key}`}
    label={view.doing === `approve:${key}` ? "Approving…" : "Approve"}
    variant="primary"
    hotkey={isFirst ? "a" : void 0}
    onPress={() => void act($, `approve:${key}`, "approve", () => approve($, g.id, item.id))}
  />
          <Text> </Text>
          <Button key={`reject-${key}`} label="Reject…" hotkey={isFirst ? "r" : void 0} onPress={() => void setRejecting($, key)} />
        </Box>}
    </Box>;
}
function controls($, e, view, g) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const isCancelling = view.pending?.kind === "cancel-run" && view.pending.goalId === g.id;
  const isDeleting = view.pending?.kind === "delete-goal" && view.pending.goalId === g.id;
  if (isDeleting) {
    return <Box key={`controls-${g.id}`} flexDirection="column" marginTop={1}>
        <Text color="yellow">Delete "{g.name}" for good, with its items, runs and memory? This can't be undone.</Text>
        <Box>
          <Button
      key={`delete-yes-${g.id}`}
      label={view.doing === `delete:${g.id}` ? "Deleting…" : "Yes, delete"}
      onPress={() => {
        void setConfirm($, null);
        void act($, `delete:${g.id}`, "delete the goal", () => deleteGoal($, g.id));
      }}
    />
          <Text dimColor> · </Text>
          {action($, e, { key: `delete-no-${g.id}`, label: "Keep it", onPress: () => void setConfirm($, null) })}
        </Box>
      </Box>;
  }
  if (isCancelling) {
    return <Box key={`controls-${g.id}`} marginTop={1}>
        <Text color="yellow">Cancel this run? </Text>
        <Button
      key={`cancel-run-yes-${g.id}`}
      label={view.doing === `cancel:${g.id}` ? "Cancelling…" : "Yes, cancel"}
      onPress={() => {
        void setConfirm($, null);
        void act($, `cancel:${g.id}`, "cancel the run", () => cancelRun($, g.id));
      }}
    />
        <Text> </Text>
        {action($, e, { key: `cancel-run-no-${g.id}`, label: "Keep running", onPress: () => void setConfirm($, null) })}
      </Box>;
  }
  const buttons = [];
  const run = lastRun(g);
  if (run && isFailed(run.status)) {
    buttons.push(<Button key={`discuss-${g.id}`} label={view.doing === `discuss:${g.id}` ? "Sending…" : "Discuss"} onPress={() => void discuss($, g, run)} />);
  }
  if (g.status === "active" && !g.oneOff) {
    buttons.push(g.schedule ? action($, e, { key: `reschedule-${g.id}`, label: view.doing === `schedule:${g.id}` ? "Choosing…" : "Reschedule", onPress: () => void act($, `schedule:${g.id}`, "change the schedule", () => rescheduleGoal($, g)) }) : action($, e, { key: `schedule-${g.id}`, label: view.doing === `schedule:${g.id}` ? "Choosing…" : "Set schedule", onPress: () => void act($, `schedule:${g.id}`, "set the schedule", async () => void await chooseSchedule($, g)) }));
  }
  if (canRun(g)) {
    buttons.push(
      action($, e, { key: `run-${g.id}`, label: view.doing === `run:${g.id}` ? "Starting…" : "Run now", hotkey: view.runnable === g.id ? "n" : void 0, onPress: () => void act($, `run:${g.id}`, "start the run", () => runNow($, g.id)) })
    );
  }
  if (g.openRun) {
    buttons.push(action($, e, { key: `cancel-run-${g.id}`, label: "Cancel run", onPress: () => void setConfirm($, { kind: "cancel-run", goalId: g.id }) }));
  }
  buttons.push(g.status === "active" ? action($, e, { key: `pause-${g.id}`, label: view.doing === `pause:${g.id}` ? "Pausing…" : "Pause", onPress: () => void act($, `pause:${g.id}`, "pause the goal", () => setGoalStatus($, g.id, "paused")) }) : action($, e, { key: `resume-${g.id}`, label: view.doing === `resume:${g.id}` ? "Resuming…" : "Resume", onPress: () => void act($, `resume:${g.id}`, "resume the goal", () => setGoalStatus($, g.id, "active")) }));
  if (!g.openRun) {
    buttons.push(action($, e, { key: `delete-${g.id}`, label: "Delete", onPress: () => void setConfirm($, { kind: "delete-goal", goalId: g.id }) }));
  }
  return <Box key={`controls-${g.id}`} marginTop={g.needsYou.length > 0 ? 1 : 0}>
      {buttons.flatMap((b, i) => i === 0 ? [b] : [<Text key={`sep-${g.id}-${i}`} dimColor> · </Text>, b])}
    </Box>;
}
function details($, e, view, g) {
  const { Box, Text, Button, Link, Input } = $.ui.resolve(e);
  const discussBox = (kind, id, run) => <Box key={`discuss-${kind}-box-${id}`} flexDirection="column">
      <Input
    key={`discuss-${kind}-input-${id}`}
    label="Your question"
    placeholder="type a question, or Enter for the usual one"
    submitLabel={view.doing === `discuss:${g.id}` ? "Sending…" : "Discuss"}
    autoFocus
    onSubmit={(text) => void discuss($, g, run, text)}
  />
      {action($, e, { key: `discuss-${kind}-cancel-${id}`, label: "Cancel", onPress: () => void setDiscussing($, null) })}
    </Box>;
  if (!g.detail) return <Text key={`details-${g.id}`} dimColor>  Loading… (if this stays, collapse some other goals: too many open at once)</Text>;
  return <Box key={`details-${g.id}`} flexDirection="column" marginTop={1}>
      <Text dimColor>{g.objective}</Text>
      <Text dimColor>Runs {scheduleLabel(g.schedule)}{g.schedule ? "" : " (set one with /goal-schedule)"}</Text>
      {g.watches.map((w) => <Text key={`watch-${g.id}/${w.name}`} dimColor>
          Also runs when "{w.name}" sees something new (checked every {w.everyMinutes} min{w.lastFiredAt ? `, last ${ago(w.lastFiredAt, view.now)}` : ""})
          {w.failing && <Text color="red"> · can't check: {w.error ?? "the command fails"}</Text>}
        </Text>)}

      <Text bold>Open items</Text>
      {g.openItems.length === 0 && <Text dimColor>  none</Text>}
      {g.openItems.map((item) => <Text key={`item-${g.id}/${item.id}`}>  · {item.title}</Text>)}
      {g.openItemCount > g.openItems.length && <Text dimColor>  … and {g.openItemCount - g.openItems.length} more</Text>}

      {view.discussing === `goal:${g.id}` ? discussBox("goal", g.id) : action($, e, { key: `discuss-goal-${g.id}`, label: "Discuss this goal…", onPress: () => void setDiscussing($, `goal:${g.id}`) })}

      <Text bold>Recent runs</Text>
      {g.runs.length === 0 && <Text dimColor>  none</Text>}
      {g.runs.map((r) => <Box key={`run-${r.id}`} flexDirection="column">
          <Text key={`run-row-${r.id}`}>
            {"  "}
            <Text color={isFailed(r.status) ? "red" : r.status === "completed" ? "green" : "cyan"}>{r.status}</Text>
            <Text dimColor> {r.trigger} · {ago(r.endedAt ?? r.startedAt, view.now)}{runCost(r) ? ` · ${runCost(r)}` : ""}</Text>
            {r.summary ? ` — ${r.summary}` : ""}
          </Text>
          {r.status !== "running" && r.status !== "queued" && (view.discussing === `run:${r.id}` ? discussBox("run", r.id, r) : action($, e, { key: `discuss-run-${r.id}`, label: "    Discuss this run…", onPress: () => void setDiscussing($, `run:${r.id}`) }))}
        </Box>)}

      <Text bold>Memory</Text>
      {g.memory.length === 0 && <Text dimColor>  none</Text>}
      {g.memory.map((m) => {
    const isConfirming = view.pending?.kind === "delete-memory" && view.pending.memoryId === m.id;
    return <Box key={`memory-${m.id}`}>
            <Text>  {m.pinned ? "📌 " : ""}<Text dimColor>[{m.kind}]</Text> {m.text} </Text>
            {isConfirming ? <Box>
                {action($, e, { key: `forget-yes-${m.id}`, label: "Delete it", onPress: () => {
      void setConfirm($, null);
      void act($, `forget:${m.id}`, "delete the memory", () => deleteMemory($, g.id, m.id));
    } })}
                <Text> </Text>
                {action($, e, { key: `forget-no-${m.id}`, label: "Keep", onPress: () => void setConfirm($, null) })}
              </Box> : action($, e, { key: `forget-${m.id}`, label: "Delete", onPress: () => void setConfirm($, { kind: "delete-memory", goalId: g.id, memoryId: m.id }) })}
          </Box>;
  })}

      <Link key={`open-${g.id}`} href={`${view.base}/goals/${encodeURIComponent(g.id)}`} label="Open in browser" />
    </Box>;
}
var DONE_SECTION = "__done__";
function doneSection($, e, view, done) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const isOpen = view.shown.includes(DONE_SECTION);
  return <Box key="done" flexDirection="column" marginBottom={1}>
      <Button key="done-toggle" plain label={`${isOpen ? "▾" : "▸"} Done (${done.length})`} onPress={() => void toggleExpanded($, DONE_SECTION)} />
      {isOpen && done.map((g) => {
    const run = lastRun(g);
    return <Box key={`done-${g.id}`} flexDirection="column">
            <Box>
              <Text>  ✓ {g.name}</Text>
              <Text dimColor> · {run ? ago(run.endedAt ?? run.startedAt, view.now) : "never run"} </Text>
              {action($, e, { key: `again-${g.id}`, label: view.doing === `run:${g.id}` ? "Starting…" : "Run again", onPress: () => void act($, `run:${g.id}`, "run it again", () => runNow($, g.id)) })}
            </Box>
            {run?.summary && <Text dimColor>    {clip(run.summary, Math.max(view.columns - 4, 10))}</Text>}
          </Box>;
  })}
    </Box>;
}
function todoSection($, e, view, todos2, addingTo2, askingAbout2, editing) {
  const { Box, Text, Button, Input } = $.ui.resolve(e);
  return <Box key="todos" flexDirection="column" marginBottom={1}>
      {todos2.lists.map((list) => {
    const key = `todo:${list.id}`;
    const isOpen = view.shown.includes(key);
    const doneKey = `todo-done:${list.id}`;
    const showDone = view.shown.includes(doneKey);
    const isDone2 = (i) => i.status === "completed" || i.status === "abandoned";
    const open = list.items.filter((i) => !isDone2(i));
    const done = list.items.filter(isDone2);
    return <Box key={key} flexDirection="column">
            <Button key={`todo-toggle-${list.id}`} plain label={`${isOpen ? "▾" : "▸"} ${list.name} (${list.open} to do)`} onPress={() => void toggleExpanded($, key)} />
            {isOpen && open.map((item) => {
      const itemKey = `todo-item:${list.id}/${item.id}`;
      const expanded2 = view.shown.includes(itemKey);
      const indent = "  ".repeat(item.depth + 1);
      return <Box key={`todo-${list.id}/${item.id}`} flexDirection="column">
                  <Box>
                    <Text>{indent}</Text>
                    <Button key={`todo-tick-${list.id}/${item.id}`} plain label={item.status === "active" ? "◐" : "☐"} onPress={() => void toggleTodo($, list, item)} />
                    <Text> </Text>
                    <Button
        key={`todo-open-${list.id}/${item.id}`}
        plain
        label={`${item.id} ${expanded2 ? "▾" : clip(item.text, Math.max(view.columns - 8 - item.id.length - item.depth * 2, 10))}`}
        onPress={() => void toggleExpanded($, itemKey)}
      />
                  </Box>
                  {expanded2 && <Box flexDirection="column">
                      {editing === `${list.id}/${item.id}` ? <Box flexDirection="column">
                          <Input
        key={`todo-edit-input-${list.id}/${item.id}`}
        label="To-do"
        value={item.text}
        submitLabel={view.doing === `todo-edit:${list.id}/${item.id}` ? "Saving…" : "Save"}
        autoFocus
        onSubmit={(text) => void editFromPane($, list, item, text)}
      />
                          {action($, e, { key: `todo-edit-cancel-${list.id}/${item.id}`, label: "Cancel", onPress: () => void setEditingTodo($, null) })}
                        </Box> : <Text>{indent}    {item.text}</Text>}
                      {item.notes && <Text dimColor>{indent}    {item.notes}</Text>}
                      {editing === `${list.id}/${item.id}` ? null : askingAbout2 === `${list.id}/${item.id}` ? <Box flexDirection="column">
                          <Input
        key={`todo-ask-input-${list.id}/${item.id}`}
        label="Your question"
        placeholder="type a question, or Enter for my opinion"
        submitLabel={view.doing === `todo-ask:${list.id}/${item.id}` ? "Asking…" : "Ask"}
        autoFocus
        onSubmit={(text) => void askFromPane($, list, item, text)}
      />
                          {action($, e, { key: `todo-ask-cancel-${list.id}/${item.id}`, label: "Cancel", onPress: () => void setAskingAbout($, null) })}
                        </Box> : <Box>
                        <Text>{indent}    </Text>
                        {action($, e, { key: `todo-ask-${list.id}/${item.id}`, label: "Ask…", onPress: () => void setAskingAbout($, `${list.id}/${item.id}`) })}
                        <Text> </Text>
                        <Button key={`todo-plan-${list.id}/${item.id}`} label={view.doing === `todo-plan:${list.id}/${item.id}` ? "Sending…" : "Plan"} onPress={() => void workFromPane($, list, item, "plan")} />
                        <Text> </Text>
                        {action($, e, { key: `todo-start-${list.id}/${item.id}`, label: view.doing === `todo-start:${list.id}/${item.id}` ? "Sending…" : "Start", onPress: () => void workFromPane($, list, item, "start") })}
                        <Text> </Text>
                        {action($, e, { key: `todo-edit-${list.id}/${item.id}`, label: "Edit", onPress: () => void setEditingTodo($, `${list.id}/${item.id}`) })}
                      </Box>}
                    </Box>}
                </Box>;
    })}
            {isOpen && done.length > 0 && <Button key={`todo-done-toggle-${list.id}`} plain label={`  ${showDone ? "▾" : "▸"} ${done.length} done`} onPress={() => void toggleExpanded($, doneKey)} />}
            {isOpen && showDone && done.map((item) => <Button
      key={`todo-untick-${list.id}/${item.id}`}
      plain
      label={`    ☑ ${item.id} ${clip(item.text, Math.max(view.columns - 10 - item.id.length, 10))}`}
      onPress={() => void toggleTodo($, list, item)}
    />)}
            {
      /* The add box opens on demand, already focused, like Reject's feedback box */
    }
            {isOpen && addingTo2 === list.id ? <Box flexDirection="column">
                <Input
      key={`todo-add-${list.id}`}
      label="New to-do"
      placeholder="type it, then Enter"
      submitLabel="Add"
      autoFocus
      onSubmit={(text) => {
        if (!text.trim()) return;
        void addFromPane($, todos2.dir, list, text.trim()).then((ok) => {
          if (ok) void setAddingTo($, null);
        });
      }}
    />
                {action($, e, { key: `todo-add-cancel-${list.id}`, label: "Cancel", onPress: () => void setAddingTo($, null) })}
              </Box> : isOpen ? action($, e, { key: `todo-addbtn-${list.id}`, label: "  + Add", onPress: () => void setAddingTo($, list.id) }) : null}
          </Box>;
  })}
    </Box>;
}
async function askToUpdate($, update2) {
  return act($, "update-install", "ask Claude to update", async () => void await sendToChat($, updatePrompt(update2), `install Quarterdeck ${update2.latest}: claude plugin update quarterdeck-goals@quarterdeck`));
}
async function discuss($, g, run, question) {
  const asked = question?.trim();
  const about = run ? `about run ${run.id} of goal "${g.name}" (${g.id})` : `about goal "${g.name}" (${g.id})`;
  const aside = asked ? `${about}: ${asked}` : about;
  const ok = await act($, `discuss:${g.id}`, "start the discussion", async () => void await sendToChat($, discussPrompt(g, run, asked), aside));
  if (ok) await setDiscussing($, null);
  return ok;
}

// templates.ts
var DAY = 1440;
function gmail(rules) {
  return Object.fromEntries(Object.entries(rules).flatMap(([tool, category]) => [
    [`mcp__*Gmail*__${tool}`, category],
    [`mcp__*gmail*__${tool}`, category]
  ]));
}
var TEMPLATES = [
  {
    label: "Unsubscribe from mailing lists",
    name: "Unsubscribe Stale Mailing Lists",
    objective: "Unsubscribe from mailing lists I no longer read, and clear their mail from my inbox",
    instructions: [
      "A sender is stale when its mail has a List-Unsubscribe header and none of its messages from the last 60 days has been opened, with at least 3 messages in that time.",
      "Never unsubscribe from or delete mail from banks, receipts or orders, or anything marked important.",
      "Propose one item per stale sender (external_ref gmail-sender:<address>), saying the sender, how many messages, and when one was last opened.",
      "Continue the scan where the last run stopped (keep where you got to in memory) until the last 60 days are covered.",
      "Before unsubscribing, confirm the sender's latest message has a List-Unsubscribe header; if it has none, abandon the item with that reason.",
      "To unsubscribe: if the message has List-Unsubscribe-Post: List-Unsubscribe=One-Click and an https link, use unsubscribe_one_click with that link (no browser). Otherwise, email the List-Unsubscribe mailto address if it has one. Only if neither works, open the List-Unsubscribe link in Chrome and confirm on that page; never browse anywhere else.",
      "If Chrome asks for permission to use a site, or a sender can only be unsubscribed by hand, ask me (add_item with ask_person, with the link).",
      "Delete means move to the bin, never delete permanently. When a sender's unsubscribe and clean-up are done, complete its item."
    ].join(" "),
    schedule: { kind: "interval", minutes: DAY },
    autonomy: { "email.unsubscribe": "propose", "email.delete": "propose", "email.send": "off" },
    tool_map: {
      "mcp__quarterdeck__unsubscribe_one_click": "email.unsubscribe",
      "mcp__claude-in-chrome__*": "email.unsubscribe",
      ...gmail({ send_message: "email.unsubscribe", "trash_*": "email.delete", "mark_*_spam": "email.delete", reply: "email.send", forward: "email.send" })
    },
    needs: "the Gmail connector (connect it with /mcp). Most senders unsubscribe in one click with no browser; for the rest it uses Claude in Chrome (which asks before each new site) or asks you to do it"
  },
  {
    label: "Weekly job scan",
    name: "Weekly Job Scan",
    objective: "Once a week, find new job ads that match what I'm looking for and tell me the top three",
    instructions: "",
    schedule: { kind: "interval", minutes: 7 * DAY },
    autonomy: { "email.send": "propose" },
    tool_map: gmail({ send_message: "email.send", reply: "email.send", forward: "email.send" }),
    needs: "Claude in Chrome or web access to search job sites; the Gmail connector only if you want the top 3 emailed",
    cv: true,
    ask: {
      question: "What jobs should I look for? Type it under Other: the role, location, minimum pay and job sites, e.g. senior software engineer, Wellington or remote, $140k+, on seek.co.nz and LinkedIn.",
      later: "Ask me in the first run",
      laterText: "",
      // set below: ASK_LATER is declared after the templates
      fill: (answer) => [
        `What I'm looking for: ${answer}.`,
        "Each run, search the job sites named (or the main ones for that location) for ads from the last week, skip ads you have already reported (keep their ids in memory), and pick the 3 that fit best.",
        "Put them in your end_run summary (title, employer, link and why each fits), so they show in the Goals pane.",
        "If the Gmail connector is available and you know my address, also propose one email.send item with the top 3; send it once I approve.",
        "Never apply for a job or contact an employer."
      ].join(" ")
    }
  },
  {
    label: "Tidy my Downloads",
    name: "Tidy Downloads",
    objective: "Delete installers older than 30 days from my Downloads folder",
    instructions: [
      "Look in my Downloads folder (top level only) for installers (.exe, .msi, .msix, .dmg, .pkg, .deb, .rpm, .AppImage) last changed more than 30 days ago.",
      "Propose one file.delete item per file (external_ref file:<full path>), with its size and date.",
      "Once approved, move it to the Recycle Bin or Trash, never delete permanently, and complete the item.",
      "Leave anything that isn't an installer alone."
    ].join(" "),
    schedule: { kind: "interval", minutes: 7 * DAY },
    autonomy: { "file.delete": "propose" },
    tool_map: {},
    needs: "nothing extra"
  },
  {
    label: "Inbox triage",
    name: "Inbox Triage",
    objective: "Keep my inbox down to what needs me: archive newsletters and notifications, and tell me what matters",
    instructions: [
      "Each run, look at inbox mail that arrived since the last run.",
      "Archive newsletters, promotions and automatic notifications I don't need to act on: propose one email.archive item per sender or kind, saying how many messages; once approved, archive them (remove the INBOX label) and complete the item.",
      "Never delete or send mail.",
      "In your end_run summary, list what looks like it needs a reply or action from me, with sender and subject."
    ].join(" "),
    schedule: { kind: "interval", minutes: 360 },
    autonomy: { "email.archive": "propose", "email.delete": "off", "email.send": "off" },
    tool_map: gmail({
      "label_*": "email.archive",
      "unlabel_*": "email.archive",
      update_message_labels: "email.archive",
      "trash_*": "email.delete",
      "mark_*_spam": "email.delete",
      send_message: "email.send",
      reply: "email.send",
      forward: "email.send"
    }),
    needs: "the Gmail connector (connect it with /mcp)"
  },
  {
    label: "Keep my GitHub profile current",
    name: "GitHub Profile",
    objective: "Keep my GitHub profile README up to date with what I've been building",
    instructions: "",
    // set below: GITHUB_PROFILE
    schedule: { kind: "interval", minutes: 7 * DAY },
    autonomy: { "profile.readme_edit": "propose" },
    tool_map: {},
    needs: "the GitHub CLI, gh (the first run installs it if it's missing; you sign in once with gh auth login)",
    ask: {
      question: "Where is your profile README checked out (the <username>/<username> repo)? Type its path under Other, or I'll find it or clone it.",
      later: "Find or clone it",
      laterText: "",
      // set below: GITHUB_FIND
      fill: (answer) => `My profile README repo is checked out at ${answer}.`
    }
  }
];
var FIRST_CHOICES = 3;
var MORE = "More…";
var GITHUB_PROFILE = [
  "Each run, check my recent public activity with gh (my repos sorted by last push, and my public events) since the last run.",
  "When something notable happened in one of my own projects (a release, a new project, a big feature), propose one profile.readme_edit item with the exact new text for the README; once approved, edit the README, commit and push it, and complete the item.",
  "Only my own projects: small contributions to other people's projects don't belong on the profile. Never change other files or other repos.",
  "If gh isn't installed, install it for this user only (winget --scope user, brew or apt). If gh isn't signed in, ask me (add_item with ask_person) to run gh auth login, and carry on next run.",
  "Keep a memory of what the profile already covers, so you never propose the same thing twice."
].join(" ");
var GITHUB_FIND = "Find my profile README repo (<username>/<username>, with gh api user for my username) checked out on this computer; if there's none, clone it next to my other repos. Say in your summary where it is.";
var CV_QUESTION = "Where is your CV? With it, I rank jobs against your experience. Type its path under Other, or let me find the latest one.";
var CV_FIND = "Find my latest CV";
var CV_SKIP = "Skip";
var PROFILE = 'Read it and save a short profile as one memory starting "CV profile:" (under 800 characters: skills, seniority, the kinds of roles that fit, and what to avoid; no contact details, no address). Rank ads against that profile, and say in "why it fits" which of my experience matches. Note the CV file and its last-modified date in the profile, and read it again when the file changes.';
function cvInstructions(answer) {
  if (answer === CV_FIND) {
    return `My CV: in your first run, find my most recent CV in my Documents folder (then Desktop and Downloads if there's none): a .pdf, .docx or .md file named like CV, resume or résumé, the newest one. Say in your summary which file you used. ${PROFILE}`;
  }
  if (answer === CV_SKIP || !answer.trim()) return "";
  return `My CV is at ${answer.trim()}. ${PROFILE}`;
}
var ASK_LATER = [
  "What I'm looking for: not set yet.",
  "If my CV is available, work it out from my CV profile (the roles that fit, at my level, near where I live or remote) and scan in your first run anyway: put the top 3 in your summary, say what you assumed, and add one item asking me to confirm or correct the role, location, minimum pay and job sites.",
  "Without a CV, add that item and wait for my answer before scanning.",
  "Each run, search the job sites (the main ones for the location if none are named) for ads from the last week, skip ads you have already reported (keep their ids in memory), and put the 3 that fit best in your end_run summary (title, employer, link and why each fits).",
  "Never apply for a job or contact an employer."
].join(" ") + " I'll answer by discussing this goal.";
var jobScan = TEMPLATES.find((t) => t.name === "Weekly Job Scan");
jobScan.ask.laterText = ASK_LATER;
var github = TEMPLATES.find((t) => t.name === "GitHub Profile");
github.instructions = GITHUB_PROFILE;
github.ask.laterText = GITHUB_FIND;

// tools.ts
var GOAL = { type: "string", description: "Goal name (or a unique part of it) or goal id." };
var ITEM = { type: "string", description: "The item id, as goals_status lists it." };
var TOOLS = [
  {
    name: "goals_status",
    description: "Lists the person's Quarterdeck goals (persistent objectives run by scheduled agents): what waits for their approval (with item ids), whether a run is going, the last run and health. Read-only.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "goal_detail",
    description: "One Quarterdeck goal in detail: objective, proposals, open items, recent runs with summaries, and its memory. Read-only.",
    inputSchema: { type: "object", properties: { goal: GOAL }, required: ["goal"] }
  },
  {
    name: "approve_item",
    description: "Approves a Quarterdeck proposal so the goal's next run carries it out. The person is asked to confirm first.",
    inputSchema: { type: "object", properties: { goal: GOAL, item_id: ITEM }, required: ["goal", "item_id"] }
  },
  {
    name: "reject_item",
    description: "Rejects a Quarterdeck proposal with feedback; the feedback is saved to the goal's memory so later runs learn from it. The person is asked to confirm first.",
    inputSchema: { type: "object", properties: { goal: GOAL, item_id: ITEM, feedback: { type: "string", description: "What should change." } }, required: ["goal", "item_id", "feedback"] }
  },
  {
    name: "answer_item",
    description: "Answers a question a Quarterdeck goal's run asked the person (an item marked as a question), with the person's own words. Only when they've given the answer.",
    inputSchema: { type: "object", properties: { goal: GOAL, item_id: ITEM, answer: { type: "string", description: "The person's answer." } }, required: ["goal", "item_id", "answer"] }
  },
  {
    name: "run_goal",
    description: "Queues a run of a Quarterdeck goal now. The person is asked to confirm first.",
    inputSchema: { type: "object", properties: { goal: GOAL }, required: ["goal"] }
  },
  {
    name: "todos",
    description: "The person's to-do lists for this project, with each open to-do's id. Read-only. Use it when they ask what's on their list, or refer to it after a compaction.",
    inputSchema: { type: "object", properties: { include_done: { type: "boolean", description: "Also list ticked-off to-dos" } } }
  },
  {
    name: "add_todo",
    description: "Adds a to-do to the person's list for this project, where it survives the conversation and shows in the Goals pane. Add what they ask you to; when an idea is clearly being put off for later, offer to add it rather than adding it unasked.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The to-do, short and in their words" }, list: { type: "string", description: 'A list name or id; left out, the "To do" list' } },
      required: ["text"]
    }
  },
  {
    name: "complete_todo",
    description: "Ticks a to-do off the person's list. Only when they say it's done or ask you to.",
    inputSchema: {
      type: "object",
      properties: { item: { type: "string", description: "The to-do id from the todos tool, e.g. 3 or 1.4" }, list: { type: "string", description: "A list name or id, when more than one list has that id" } },
      required: ["item"]
    }
  },
  {
    name: "edit_todo",
    description: "Rewords a to-do on the person's list (and its notes, when given). Only when they ask you to; the old wording is shown to them so they can put it back.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "The to-do id from the todos tool, e.g. 3 or 1.4" },
        text: { type: "string", description: "The new wording, short and in their words" },
        notes: { type: "string", description: "New notes; left out, the notes stay as they are" },
        list: { type: "string", description: "A list name or id, when more than one list has that id" }
      },
      required: ["item", "text"]
    }
  },
  {
    name: "update_goal",
    description: "Changes a Quarterdeck goal: name, objective, standing instructions, autonomy per action category (off / propose / auto; null puts one back to the default, propose), tool rules (tool name pattern → category; null removes one), memory to add or forget (ids from goal_detail), watches, or pause / resume. A watch starts a run when something happens (a new issue, a feed entry, a file, an email): it is a shell command, run every few minutes in the goal's directory, that prints one line per current item, or a read-only connector tool called every few minutes; an item not there before starts a run, which is told the new ones. The answer says whether each new watch's command worked. Try the command or the tool yourself first; the goal-watches skill has recipes. The person sees each change and is asked to confirm first. For the schedule use set_schedule.",
    inputSchema: {
      type: "object",
      properties: {
        goal: GOAL,
        name: { type: "string" },
        objective: { type: "string" },
        instructions: { type: "string", description: 'The new standing instructions in full; "" clears them' },
        autonomy: { type: "object", additionalProperties: { type: ["string", "null"], enum: ["off", "propose", "auto", null] } },
        tool_map: { type: "object", additionalProperties: { type: ["string", "null"] } },
        add_memory: {
          type: "array",
          items: { type: "object", properties: { kind: { type: "string", enum: ["fact", "rule", "preference"] }, text: { type: "string" }, pinned: { type: "boolean" } }, required: ["kind", "text"] }
        },
        forget_memory: { type: "array", items: { type: "string" }, description: "Memory ids" },
        watches: {
          type: "object",
          description: "Watch name → the watch; null removes it. Giving an existing name changes that watch",
          additionalProperties: {
            type: ["object", "null"],
            description: "Give a command or a tool, one of them",
            properties: {
              command: { type: "string", description: "Prints one line per current item and exits 0. Runs under cmd.exe on Windows and sh elsewhere, so quote with double quotes" },
              tool: { type: "string", description: "For what only a connector reaches (mail, calendar, files): the full name of a tool that only reads, e.g. a mail search. The session running goals calls it with nobody asked" },
              input: { type: "object", description: "The tool's arguments. Ask for ids only, and few results" },
              match: { type: "string", description: `A regular expression over the tool's answer; each match (its first group) is one item. Left out: every "id" in a JSON answer` },
              every_minutes: { type: "number", description: "How often to check (default 5, at least 1)" }
            }
          }
        },
        status: { type: "string", enum: ["active", "paused"] }
      },
      required: ["goal"]
    }
  },
  {
    name: "set_schedule",
    description: 'Sets when a Quarterdeck goal runs on its own, or "off" for on demand only. The person is asked to confirm first.',
    inputSchema: {
      type: "object",
      properties: { goal: GOAL, schedule: { type: "string", description: `One of: ${SCHEDULE_USAGE}` } },
      required: ["goal", "schedule"]
    }
  }
];
async function registerTools($) {
  for (const tool of TOOLS) {
    try {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    } catch {
    }
  }
}
async function resolveGoal($, query) {
  const s = await refresh($);
  if (!s.reachable) return { error: `Quarterdeck isn't connected${s.error ? ` (${s.error})` : ""}. Check the quarterdeck MCP server with /mcp.` };
  const found = findGoal(s.goals, typeof query === "string" ? query : "");
  return "goal" in found ? found : { error: noMatch(s.goals, String(query ?? ""), found.matches) };
}
async function withDetail($, goal) {
  const res = await fetchOverview($, null, [goal.id]);
  const full = res.changed ? res.goals.find((g) => g.id === goal.id) : void 0;
  return full ? toCard(full) : goal;
}
async function confirmWith($, question, yes) {
  try {
    return await $.ui.ask(question, [yes, "Cancel"]) === yes;
  } catch {
    return false;
  }
}
async function runTool($, name, input) {
  const now = await $.clock.now();
  const fail = (text) => ({ text, isError: true });
  if (name === "todos" || name === "add_todo" || name === "complete_todo" || name === "edit_todo") return todoTool($, name, input);
  if (name === "goals_status") {
    const lastAlert = await readLastAlert($);
    const lastPoll = await readLastPoll($);
    const traced = await readTrace($);
    const s = await refresh($);
    if (!s.reachable) return fail(`Quarterdeck isn't connected${s.error ? ` (${s.error})` : ""}. Check the quarterdeck MCP server with /mcp.`);
    const at = (ms) => `${new Date(ms).toISOString()}, ${ago(new Date(ms).toISOString(), now)}`;
    const alert = lastAlert ? `

Last alert (${at(lastAlert.at)}): ${lastAlert.text}. Notification: ${lastAlert.notify}. Phone: ${lastAlert.push}.` : "";
    const poll = lastPoll ? `
Last background poll: ${at(lastPoll)}.` : "\nNo background poll recorded.";
    const checks = traced.length ? `
Alert checks (oldest first):
${traced.map((l) => `- ${l}`).join("\n")}` : "";
    return { text: summarize(s.goals, now) + alert + poll + checks, isError: false };
  }
  const found = await resolveGoal($, input.goal);
  if ("error" in found) return fail(found.error);
  let { goal } = found;
  if (!goal.detail && (name === "goal_detail" || name === "update_goal")) goal = await withDetail($, goal);
  if (name === "goal_detail") return { text: describe(goal, now), isError: false };
  if (name === "update_goal") {
    const keys = ["name", "objective", "instructions", "autonomy", "tool_map", "add_memory", "forget_memory", "watches", "status"];
    const changes = Object.fromEntries(keys.filter((k) => input[k] !== void 0).map((k) => [k, input[k]]));
    const lines = describeGoalChanges(goal, changes);
    if (lines.length === 0) return fail(`Nothing to change in ${goal.name}: give at least one new value.`);
    if (!await confirmWith($, `Change the goal "${goal.name}"?
${lines.map((l) => `• ${l}`).join("\n")}`, "Apply changes")) return fail("The person declined; the goal is unchanged.");
    let changed = [];
    let watches = [];
    const ok = await act($, `update:${goal.id}`, "change the goal", async () => {
      ({ changed, watches } = await updateGoal($, goal.id, changes));
    });
    if (!ok) return fail("The change didn't go through; see the Goals pane.");
    if (watches.length) void kick($).catch(() => {
    });
    const checks = watches.map((w) => ` Watch "${w.name}": ${w.result}.`).join("");
    return { text: `Changed ${goal.name}: ${changed.join("; ") || "nothing (already so)"}.${checks}`, isError: false };
  }
  if (name === "set_schedule") {
    const parsed = await readSchedule($, String(input.schedule ?? ""));
    if ("error" in parsed) return fail(parsed.error);
    const label = parsed.oneOff ? "once (one-off)" : scheduleLabel(parsed.schedule);
    if (!await confirmWith($, `Run the goal "${goal.name}" ${label}?`, "Set schedule")) return fail("The person declined; the schedule is unchanged.");
    return { text: await applySchedule($, goal, parsed.schedule, parsed.oneOff), isError: false };
  }
  if (name === "run_goal") {
    if (goal.openRun) return fail(`${goal.name} already has a run ${goal.openRun.status}.`);
    if (!await confirmWith($, `Start a run of the goal "${goal.name}" now?`, "Run it")) return fail("The person declined; nothing was started.");
    return await act($, `run:${goal.id}`, "start the run", () => runNow($, goal.id)) ? { text: `Queued a run of ${goal.name}.`, isError: false } : fail(`The run didn't start.`);
  }
  const item = goal.needsYou.find((i) => i.id === String(input.item_id ?? ""));
  if (!item) {
    const waiting = goal.needsYou.map((i) => `${i.id} (${i.title})`).join(", ");
    return fail(`No proposal ${String(input.item_id)} waits in ${goal.name}.${waiting ? ` Waiting: ${waiting}.` : " Nothing is waiting."}`);
  }
  const key = `${goal.id}/${item.id}`;
  if (name === "answer_item") {
    const text = String(input.answer ?? "").trim();
    if (!text) return fail("An answer is needed.");
    if (!item.asksPerson) return fail(`"${item.title}" is a proposal, not a question: approve or reject it.`);
    return await act($, `answer:${key}`, "answer", () => answerItem($, goal.id, item.id, text)) ? { text: `Answered "${item.title}"; ${goal.name}'s next run carries on with it (queued now).`, isError: false } : fail("The answer failed; see the Goals pane.");
  }
  if (name === "approve_item") {
    const what = `"${item.title}"${item.summary ? ` (${item.summary})` : ""}`;
    if (!await confirmWith($, `Approve ${what} for the goal "${goal.name}"?`, "Approve")) return fail("The person declined; nothing was approved.");
    return await act($, `approve:${key}`, "approve", () => approve($, goal.id, item.id)) ? { text: `Approved "${item.title}". ${goal.name}'s next run will carry it out.`, isError: false } : fail("The approval failed; see the Goals pane.");
  }
  const feedback = String(input.feedback ?? "").trim();
  if (!feedback) return fail("Feedback is required to reject a proposal.");
  if (!await confirmWith($, `Reject "${item.title}" for "${goal.name}" with this feedback: "${feedback}"?`, "Reject")) return fail("The person declined; nothing was rejected.");
  return await act($, `reject:${key}`, "reject", () => reject($, goal.id, item.id, feedback)) ? { text: `Rejected "${item.title}"; the feedback is saved to ${goal.name}'s memory.`, isError: false } : fail("The rejection failed; see the Goals pane.");
}
var COMMANDS = [
  { name: "goals", description: "Show Quarterdeck goals in a pane" },
  { name: "goal-run", description: "Run a Quarterdeck goal now", argumentHint: "<goal>" },
  { name: "goal-new", description: "Create a Quarterdeck goal in this directory (it suggests a title and a schedule)", argumentHint: "<objective> | <name>: <objective>" },
  { name: "goal-pause", description: "Pause a Quarterdeck goal", argumentHint: "<goal>" },
  { name: "goal-resume", description: "Resume a paused Quarterdeck goal", argumentHint: "<goal>" },
  { name: "todo", description: "Your to-do list for this project: /todo <text> adds, /todo done <id> ticks off, /todo shows it", argumentHint: "<text> | done <id>" },
  { name: "goal-schedule", description: "Set when a Quarterdeck goal runs on its own", argumentHint: "<goal> every 6h | cron ... | off" }
];
async function registerCommands($) {
  for (const c of COMMANDS) await $.command.register(c);
}
async function goalCommand($, command, args) {
  if (!args.trim()) {
    const s = await refresh($);
    return `Usage: /${command} <goal>. Goals: ${s.goals.map((g) => g.name).join(", ") || "none"}.`;
  }
  const found = await resolveGoal($, args);
  if ("error" in found) return found.error;
  const { goal } = found;
  const ok = (done, text) => done ? text : `That didn't work; see the Goals pane.`;
  if (command === "goal-run") {
    if (goal.openRun) return `${goal.name} already has a run ${goal.openRun.status}.`;
    return ok(await act($, `run:${goal.id}`, "start the run", () => runNow($, goal.id)), `Queued a run of ${goal.name}.`);
  }
  const status = command === "goal-pause" ? "paused" : "active";
  if (goal.status === status) return `${goal.name} is already ${status}.`;
  return ok(await act($, `${command}:${goal.id}`, `${command === "goal-pause" ? "pause" : "resume"} the goal`, () => setGoalStatus($, goal.id, status)), `${goal.name} is ${status === "paused" ? "paused" : "active again"}.`);
}
async function newFromTemplate($) {
  let picked;
  try {
    const first = TEMPLATES.slice(0, FIRST_CHOICES).map((t) => t.label);
    const rest = TEMPLATES.slice(FIRST_CHOICES).map((t) => t.label);
    picked = await $.ui.ask("What should I look after? Pick a ready-made goal, or type your own under Other (e.g. keep my inbox under 20 unread).", rest.length ? [...first, MORE] : first);
    if (picked === MORE) picked = await $.ui.ask("More ready-made goals: pick one, or type your own under Other.", rest.length > 1 ? rest : [...rest, "Cancel"]);
  } catch {
    return "No goal created.";
  }
  const template = TEMPLATES.find((t) => t.label === picked);
  if (!template) return picked.trim() && !/^cancel$/i.test(picked.trim()) ? newGoal($, picked) : "No goal created.";
  let instructions = template.instructions;
  if (template.ask) {
    let answer;
    try {
      answer = await $.ui.ask(template.ask.question, [template.ask.later, "Cancel"]);
    } catch {
      return "No goal created.";
    }
    if (answer === "Cancel" || !answer.trim()) return "No goal created.";
    const first = answer === template.ask.later ? template.ask.laterText : template.ask.fill(answer.trim());
    instructions = [first, template.instructions].filter(Boolean).join(" ");
  }
  if (template.cv) {
    let answer = CV_SKIP;
    try {
      answer = await $.ui.ask(CV_QUESTION, [CV_FIND, CV_SKIP]);
    } catch {
    }
    const cv = /^cancel$/i.test(answer.trim()) ? "" : cvInstructions(answer);
    if (cv) instructions = `${instructions} ${cv}`;
  }
  const cwd = await $.session.root();
  try {
    await createGoal($, {
      name: template.name,
      objective: template.objective,
      working_dir: cwd,
      schedule: template.schedule,
      instructions,
      autonomy: template.autonomy,
      tool_map: template.tool_map
    });
  } catch (err) {
    return `Couldn't create the goal: ${err instanceof Error ? err.message : String(err)}`;
  }
  await kick($);
  await refresh($);
  return `Created the goal "${template.name}" in ${cwd}, running ${scheduleLabel(template.schedule)}; the first run starts within a minute. It needs ${template.needs}. It asks before it acts: approve or reject its proposals under Needs you. Change anything by discussing the goal.${await phoneHint($)}`;
}
async function newGoal($, args) {
  const { name: given, objective } = splitGoalArgs(args);
  if (!objective) return newFromTemplate($);
  const cwd = await $.session.root();
  const suggestion = await suggestSchedule($, given, objective);
  const name = given ?? suggestion.title ?? fallbackTitle(objective);
  const choice = await askSchedule($, name, suggestion);
  let created;
  try {
    created = await createGoal($, { name, objective, working_dir: cwd, schedule: choice.schedule, one_off: choice.oneOff });
  } catch (err) {
    return `Couldn't create the goal: ${err instanceof Error ? err.message : String(err)}`;
  }
  await kick($);
  await refresh($);
  const where = `in ${cwd}`;
  if (choice.oneOff) return `Created the one-off goal "${name}" ${where}. It runs now and moves to Done when it finishes.${await phoneHint($)}`;
  const watch = soundsEventDriven(objective) ? ` To start a run as soon as something happens, not only on a timer, ask Claude to add a watch to "${name}".` : "";
  if (!choice.schedule) return `Created the goal "${name}" ${where}. It runs when you start it (/goal-run); give it a schedule any time with /goal-schedule.${watch}${await phoneHint($)}`;
  return `Created the goal "${name}" ${where}, running ${scheduleLabel(choice.schedule)}; the first run starts within a minute.${watch}${await phoneHint($)}`;
}
async function applySchedule($, goal, schedule, oneOff = false) {
  let next = null;
  const done = await act($, `schedule:${goal.id}`, "set the schedule", async () => {
    next = (await setSchedule($, goal.id, schedule, oneOff)).next_run_at;
  });
  if (!done) return "That didn't work; see the Goals pane.";
  if (oneOff) return `${goal.name} is a one-off now: run it with /goal-run; it moves to Done when a run leaves nothing open.`;
  if (!schedule) return `${goal.name} now runs only on demand (/goal-run).`;
  const now = await $.clock.now();
  const when = !next || Date.parse(next) <= now + 6e4 ? "the next run starts within a minute" : `next run ${ago(next, now)}`;
  return `${goal.name} runs ${scheduleLabel(schedule)}; ${when}.`;
}
async function scheduleCommand($, args) {
  const usage = `Usage: /goal-schedule <goal> <when>, e.g. /goal-schedule inbox every 6h, or 30d, weekly, cron 0 9 * * 1-5, off (${SCHEDULE_USAGE})`;
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return usage;
  let goal = null;
  let when = "";
  const s = await refresh($);
  for (let i = words.length - 1; i >= 1 && !goal; i--) {
    const found = findGoal(s.goals, words.slice(0, i).join(" "));
    if ("goal" in found) {
      goal = found.goal;
      when = words.slice(i).join(" ");
    }
  }
  if (!goal) {
    const found = await resolveGoal($, words[0]);
    return "error" in found ? found.error : usage;
  }
  const parsed = await readSchedule($, when);
  if ("error" in parsed) return parsed.error;
  const text = await applySchedule($, goal, parsed.schedule, parsed.oneOff);
  return parsed.interpreted ? `${text} (Read "${when}" as ${parsed.interpreted}.)` : text;
}
async function todoTool($, name, input) {
  const dir = await $.session.root();
  const lists = await fetchTodos($, dir);
  const listArg = typeof input.list === "string" && input.list.trim() ? input.list.trim() : void 0;
  if (name === "todos") return { text: describeTodos(lists, { withDone: input.include_done === true }), isError: false };
  if (name === "add_todo") {
    const text = String(input.text ?? "").trim();
    if (!text) return { text: "A to-do needs some text.", isError: true };
    const list = listArg ? lists.find((l) => l.id === listArg || l.name.toLowerCase() === listArg.toLowerCase()) : void 0;
    if (listArg && !list) return { text: `No list "${listArg}". Lists: ${lists.map((l) => l.name).join(", ") || "none"}.`, isError: true };
    const r = await addTodo($, { dir, text, listId: list?.id, by: "agent" });
    await refreshTodos($);
    return { text: `Added to ${list?.name ?? "To do"} as ${r.item_id}: ${text}`, isError: false };
  }
  const found = findTodo(lists, String(input.item ?? ""), listArg);
  if ("error" in found) return { text: found.error, isError: true };
  if (name === "edit_todo") {
    const text = String(input.text ?? "").trim();
    if (!text) return { text: "A to-do needs some text.", isError: true };
    const notes = typeof input.notes === "string" ? input.notes : void 0;
    await editTodo($, found.list.id, found.item.id, { text, notes, by: "agent" });
    await refreshTodos($);
    $.ui.toast(`Reworded to-do ${found.item.id}. It said: ${clip(found.item.text, 80)}`);
    return { text: `Reworded ${found.item.id}: ${text} (it said: ${found.item.text})`, isError: false };
  }
  await setTodo($, found.list.id, found.item.id, "completed");
  await refreshTodos($);
  return { text: `Ticked off ${found.item.id}: ${found.item.text}`, isError: false };
}

// register.tsx
var started = false;
async function start2($, openPane) {
  if (started) return;
  started = true;
  resetAlerts();
  await registerCommands($);
  await registerTools($);
  await registerRunnerAgent($);
  const first = await refresh($);
  startPolling($, first);
  startRunner($);
  if (openPane && first.goals.some((g) => g.needsYou.length > 0)) void $.ui.open({ id: PANE, title: "Goals" });
}
async function safeStart($, openPane) {
  try {
    await start2($, openPane);
  } catch {
    started = false;
  }
}
async function answerTool($, name, e) {
  const { text, isError } = await runTool($, name, e);
  return { result: isError ? `Error: ${text}` : text };
}
function runIds(e) {
  const input = e;
  return {
    goalId: typeof input.goal_id === "string" ? input.goal_id : null,
    runId: typeof input.run_id === "string" ? input.run_id : null
  };
}
function passOn(_$, e, next) {
  return next(e);
}
function failedCommand() {
  return { text: "quarterdeck-goals hit an error; see the Goals pane, or run claude --debug." };
}
function failedTool() {
  return { result: "Error: the quarterdeck-goals tool failed unexpectedly." };
}
function byPerson(origin) {
  return origin?.kind === "composer" || origin?.kind === "bridge";
}
export const register = (on, options) => {
  configure(options);
  on("session.start", async ($, e, next) => {
    await safeStart($, true);
    return next(e);
  }).catch(passOn);
  on("prompt.submit", async ($, e, next) => {
    await safeStart($, false);
    if (byPerson(e.origin)) void $.clock.now().then((t) => markActive($, t));
    if (e.origin?.kind === "bridge") void markRemote($);
    return next(e);
  }).catch(passOn);
  on("session.receive", async ($, e, next) => {
    await safeStart($, false);
    if (!e.agentId && byPerson(e.origin)) void $.clock.now().then((t) => markActive($, t));
    if (!e.agentId && e.origin?.kind === "bridge") void markRemote($);
    return next(e);
  }).catch(passOn);
  on("session.end", async ($, e, next) => {
    stopPolling();
    await stopRunner($);
    started = false;
    const result = await next(e);
    if (e.reason === "clear" || e.reason === "resume") void safeStart($, false);
    return result;
  }).catch(passOn);
  on("agent.offer", { agent: RUNNER_AGENT }, () => ({ isOffered: false }));
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) void safeStart($, false);
    if (e.agentId && (await getRuns($))[e.agentId]) {
      $.clock.after(2e3, () => {
        void reconcile($).then((ended) => {
          if (ended) void refresh($);
        });
      });
    }
    return result;
  }).catch(passOn);
  on("command.run", { command: "goals" }, async ($) => {
    await safeStart($, false);
    const s = await refresh($);
    await $.ui.open({ id: PANE, title: "Goals" });
    return { text: s.reachable ? "Goals pane opened." : `Goals pane opened, but Quarterdeck isn't reachable (${s.error ?? "no answer"}).` };
  }).catch(failedCommand);
  on("command.run", { command: "goal-run" }, async ($, e) => ({ text: await goalCommand($, "goal-run", e.args) })).catch(failedCommand);
  on("command.run", { command: "goal-pause" }, async ($, e) => ({ text: await goalCommand($, "goal-pause", e.args) })).catch(failedCommand);
  on("command.run", { command: "goal-resume" }, async ($, e) => ({ text: await goalCommand($, "goal-resume", e.args) })).catch(failedCommand);
  on("command.run", { command: "goal-new" }, async ($, e) => ({ text: await newGoal($, e.args) })).catch(failedCommand);
  on("command.run", { command: "goal-schedule" }, async ($, e) => ({ text: await scheduleCommand($, e.args) })).catch(failedCommand);
  on("command.run", { command: "todo" }, async ($, e) => ({ text: await todoCommand($, e.args) })).catch(failedCommand);
  on("tool.call", { tool: "mcp__quarterdeck-goals__goals_status" }, ($, e) => answerTool($, "goals_status", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__goal_detail" }, ($, e) => answerTool($, "goal_detail", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__approve_item" }, ($, e) => answerTool($, "approve_item", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__reject_item" }, ($, e) => answerTool($, "reject_item", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__answer_item" }, ($, e) => answerTool($, "answer_item", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__run_goal" }, ($, e) => answerTool($, "run_goal", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__set_schedule" }, ($, e) => answerTool($, "set_schedule", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__update_goal" }, ($, e) => answerTool($, "update_goal", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__todos" }, ($, e) => answerTool($, "todos", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__add_todo" }, ($, e) => answerTool($, "add_todo", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__complete_todo" }, ($, e) => answerTool($, "complete_todo", e)).catch(failedTool);
  on("tool.call", { tool: "mcp__quarterdeck-goals__edit_todo" }, ($, e) => answerTool($, "edit_todo", e)).catch(failedTool);
  for (const tool of serverToolNames("get_goal_brief")) on("tool.call", { tool }, async ($, e, next) => {
    const result = await next(e);
    const { goalId, runId } = runIds(e);
    if (!e.agentId && goalId && runId && result.deny === void 0 && result.isError !== true) {
      const current = await getActiveRun($);
      if (current?.runId !== runId) await setActiveRun($, { goalId, runId, startedAt: await $.clock.now() });
    }
    return result;
  }).catch(passOn);
  for (const tool of serverToolNames("end_run")) on("tool.call", { tool }, async ($, e, next) => {
    const result = await next(e);
    if (result.deny === void 0 && result.isError !== true) {
      if (!e.agentId) await setActiveRun($, null);
      void refresh($);
    }
    return result;
  }).catch(passOn);
  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) => renderPane($, e));
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const run = await getActiveRun($);
    const background = Object.values(await getRuns($));
    if (!run && background.length === 0 || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const now = await $.clock.now();
    if (run) {
      const s = await getSnapshot($);
      const name = s.goals.find((g) => g.id === run.goalId)?.name ?? run.goalId;
      return <Box>
          <Text color="cyan">● Running goal {name}</Text>
          <Text dimColor> · run {run.runId} · started {ago(new Date(run.startedAt).toISOString(), now)}</Text>
        </Box>;
    }
    const first = background[0];
    const more = background.length > 1 ? ` and ${background.length - 1} more` : "";
    return <Box>
        <Text color="cyan">● Goal run: {first.name}{more}</Text>
        <Text dimColor> · in the background · started {ago(new Date(first.startedAt).toISOString(), now)} · /goals</Text>
      </Box>;
  });
};
