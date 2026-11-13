/**
 * The Goals pane: one card per goal with its proposals (Approve / Reject),
 * controls (Run now, Pause / Resume, Cancel run) and, expanded, its open
 * items, recent runs and memory. A goal with nothing for the person (isQuiet)
 * is one line until it is expanded.
 *
 * Hotkeys while the pane has focus: a / r approve or reject the first
 * proposal, n runs the first goal that shows Run now, g refreshes, 1–9 expand
 * a goal.
 */
import type { EngineInterface, RenderChildren, RenderInput } from 'claude-code'

import type { Confirm, GoalCard, TodoItem, Todos, Update } from '../types'
import { answerItem, approve, baseUrl, deleteGoal, deleteMemory, NOT_LOADED, reject, runNow, setGoalStatus, trustMemory, updateGoal } from './api'
import { cancelRun } from './runner'
import { chooseSchedule, rescheduleGoal } from './schedule'
import { ago, allowRules, allowRulesPrompt, clip, discussPrompt, goalModelLabel, holdUntilText, isFailed, isQuiet, lastRun, MODEL_CHOICES, modelName, nextRunText, permissionWhere, readModelAnswer, runCost, runTokens, scheduleLabel, spark, updatePrompt } from './model'
import { connectRemote } from './alerts'
import { sendToChat } from './chat'
import { getAddingTo, getAskingAbout, getBusy, getDiscussing, getEditingTodo, getConfirm, getExpanded, getGuardMissing, getNotice, getPhone, getRejecting, getRuns, getSnapshot, getTodos, setAddingTo, setAskingAbout, setConfirm, setDiscussing, setEditingTodo, setRejecting, toggleExpanded } from './state'
import { addFromPane, askFromPane, editFromPane, toggleTodo, workFromPane } from './todos'
import { GUARD_MISSING } from './runner'
import { act, refresh } from './sync'

type Engine = EngineInterface
type E = RenderInput<'Pane'>

/** What every part of the pane reads, gathered once per draw. */
type View = {
  now: number
  /** The pane body's width, for clipping one-line text. */
  columns: number
  base: string
  doing: string | null
  open: string | null
  shown: string[]
  pending: Confirm | null
  /** "goal:<id>" or "run:<id>" while that Discuss question box is open. */
  discussing: string | null
  /** The first proposal in the pane, which a / r act on. */
  first: string | null
  /** The goal n runs. */
  runnable: string | null
  /** Goals whose open run this session started (its permission prompts show here). */
  mine: string[]
  /** The standing session holds the scheduler lease (so it started the other runs). */
  standing: boolean
}

/** The colour of every action you can press that is drawn as plain words: the theme's own, so it follows the person's theme. */
const ACTION_COLOR = 'suggestion'

/**
 * A plain button for an action (Pause, Delete, Ask…, Cancel): the label in the
 * one action colour, so it reads as something to press and not as text. Rows
 * that are content you press (a goal's name, a to-do's text, ☐) stay uncoloured.
 */
function action($: Engine, e: E, p: { key: string; label: string; hotkey?: string; onPress: () => void }) {
  const { Button, Text } = $.ui.resolve(e)
  return (
    <Button key={p.key} plain label={p.label} hotkey={p.hotkey} onPress={p.onPress}>
      <Text color={ACTION_COLOR}>{p.label}</Text>
    </Button>
  )
}

function canRun(g: GoalCard): boolean {
  return g.status === 'active' && !g.openRun
}

export async function renderPane($: Engine, e: E) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await getSnapshot($)
  const message = await getNotice($)
  const guardMissing = await getGuardMissing($)
  const todos = await getTodos($)
  const addingTo = await getAddingTo($)
  const askingAbout = await getAskingAbout($)
  const editing = await getEditingTodo($)
  const phone = await getPhone($)

  // Not read yet (a new session, or just after /clear): that is not a failed connection
  if (!s.reachable && s.fetchedAt === 0 && !s.error) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Reading your goals…</Text>
        <Button key="retry" label="Refresh" hotkey="g" onPress={() => void refresh($)} />
      </Box>
    )
  }

  if (!s.reachable && s.goals.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>Quarterdeck isn't connected.</Text>
        {s.error === NOT_LOADED
          ? <Text dimColor>{NOT_LOADED}</Text>
          : (
            <Box flexDirection="column">
              <Text dimColor>The quarterdeck MCP server comes with this plugin: check it in /mcp, or run /reload-plugins.</Text>
              {s.error && <Text dimColor>{s.error}</Text>}
            </Box>
          )}
        <Button key="retry" label="Retry" hotkey="g" onPress={() => void refresh($)} />
      </Box>
    )
  }

  // Done one-offs (retired) go in their own section at the bottom
  const current = s.goals.filter((g) => g.status !== 'retired')
  const done = s.goals.filter((g) => g.status === 'retired')
  const firstWithProposal = current.find((g) => g.needsYou.length > 0)
  const shown = await getExpanded($)
  // A goal with nothing for the person is one line until it is expanded
  const oneLine = current.map((g) => isQuiet(g) && !shown.includes(g.id))
  // A quiet goal the person expanded (its title must stay where they pressed it)
  const opened = current.map((g) => isQuiet(g) && shown.includes(g.id))
  const view: View = {
    now: await $.clock.now(),
    columns: e.props.bodyColumns,
    base: await baseUrl($),
    doing: await getBusy($),
    open: await getRejecting($),
    shown,
    pending: await getConfirm($),
    discussing: await getDiscussing($),
    first: firstWithProposal ? `${firstWithProposal.id}/${firstWithProposal.needsYou[0]!.id}` : null,
    // Only a full card has Run now to carry the hotkey
    runnable: current.find((g, i) => canRun(g) && !oneLine[i])?.id ?? null,
    mine: Object.values(await getRuns($)).map((r) => r.goalId),
    standing: s.standing === true,
  }

  return (
    <Box flexDirection="column">
      {guardMissing && <Text color="yellow">{GUARD_MISSING}</Text>}
      {s.outdated && <Text color="yellow">Quarterdeck was updated in another session: run /reload-plugins here to use the new version (this session won't start goal runs until then).</Text>}
      {s.update && (
        <Box>
          <Text color="yellow">Quarterdeck {s.update.latest} is available (you have {s.update.installed}). </Text>
          {action($, e, { key: 'update-install', label: view.doing === 'update-install' ? 'Sending…' : 'Ask Claude to install it', onPress: () => void askToUpdate($, s.update!) })}
        </Box>
      )}
      {s.standing && <Text dimColor>The standing session is starting goal runs, so they also run with this window closed.</Text>}
      {s.hold && <Text color="yellow">Goal runs are on hold until {holdUntilText(s.hold.until, view.now)}: the usage limit is reached. Due runs start after that.</Text>}
      {phone === 'no_transport' && (
        <Box>
          <Text color="yellow">Alerts can't reach your phone: Remote Control isn't connected in this session. </Text>
          {action($, e, { key: 'phone-connect', label: view.doing === 'phone-connect' ? 'Connecting…' : 'Connect', onPress: () => void act($, 'phone-connect', 'connect Remote Control', async () => {
            const failed = await connectRemote($)
            if (failed) throw new Error(failed)
          }) })}
        </Box>
      )}
      {phone === 'config_off' && <Text color="yellow">Alerts can't reach your phone: mobile push is off. Turn it on in /config.</Text>}
      {!s.reachable && <Text color="yellow">Offline — showing the last read ({ago(new Date(s.fetchedAt).toISOString(), view.now)}).</Text>}
      {current.length === 0 && done.length === 0 && !todos?.lists.length && welcome($, e)}
      {current.length === 0 && (done.length > 0 || !!todos?.lists.length) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>No goals yet.</Text>
          <Text dimColor>Create one with /goal-new &lt;objective&gt;; /goal-new alone offers ready-made ones.</Text>
        </Box>
      )}
      {current.map((g, i) => (oneLine[i]
        // One-line goals sit together; a blank line only before a card that needs you or the
        // next section, none above a goal you opened, so its title stays where you pressed it
        ? quietLine($, e, view, g, i, oneLine[i + 1] || opened[i + 1] ? 0 : 1)
        : goalCard($, e, view, g, i)))}
      {todos && todos.lists.length > 0 && todoSection($, e, view, todos, addingTo, askingAbout, editing)}
      {done.length > 0 && doneSection($, e, view, done)}
      {message && <Text color="red">{message}</Text>}
      <Box>
        <Text dimColor>Last change {ago(new Date(s.fetchedAt).toISOString(), view.now)} </Text>
        {action($, e, { key: 'refresh', label: 'Refresh', hotkey: 'g', onPress: () => void refresh($) })}
      </Box>
    </Box>
  )
}

/** A blank pane (no goals, no to-dos): what Quarterdeck is and how to start. */
function welcome($: Engine, e: E) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key="welcome" flexDirection="column" marginBottom={1}>
      <Text>Welcome to Quarterdeck.</Text>
      <Text dimColor>A goal is a standing job Claude keeps doing in the background, like "keep my inbox under 20 unread". Each run reports here, and anything it wants to do waits for your OK.</Text>
      <Text> </Text>
      <Text dimColor>/goal-new                pick a ready-made goal</Text>
      <Text dimColor>/goal-new &lt;objective&gt;    start your own (it suggests a schedule)</Text>
      <Text dimColor>/todo &lt;text&gt;             add to this project's to-do list, shown here</Text>
    </Box>
  )
}

/**
 * A goal with nothing for the person, on one line: its name (press it, or its
 * number, for the full card), the tokens its last run used and when it runs next.
 */
function quietLine($: Engine, e: E, view: View, g: GoalCard, index: number, gap: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const run = lastRun(g)
  const facts = [
    g.status === 'active' ? '' : ` · ${g.status}`,
    // What the last run used; when it ran only if its tokens weren't recorded
    ` · ${run ? runTokens(run) || `ran ${ago(run.endedAt ?? run.startedAt, view.now)}` : 'no runs yet'}`,
    nextRunText(g, view.now),
    g.openItemCount > 0 ? ` · ${g.openItemCount} open` : '',
  ].join('')
  // The name keeps its room; the facts take what is left of the line ("1: ▸ " comes first)
  const room = view.columns - 5 - [...g.name].length
  return (
    <Box key={g.id} marginBottom={gap}>
      <Button key={`toggle-${g.id}`} plain label={`▸ ${g.name}`} hotkey={index < 9 ? String(index + 1) : undefined} onPress={() => void toggleExpanded($, g.id).then(() => refresh($))} />
      {room >= 8 && <Text dimColor>{clip(facts, room)}</Text>}
    </Box>
  )
}

function goalCard($: Engine, e: E, view: View, g: GoalCard, index: number) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const isOpen = view.shown.includes(g.id)
  const run = lastRun(g)
  const toggle = () => void toggleExpanded($, g.id).then(() => refresh($))

  return (
    <Box key={g.id} flexDirection="column" marginBottom={1}>
      <Box>
        <Button key={`toggle-${g.id}`} plain label={`${isOpen ? '▾' : '▸'} ${g.name}`} hotkey={index < 9 ? String(index + 1) : undefined} onPress={toggle} />
        <Text dimColor> {g.status}</Text>
        {g.openRun && <Text color="cyan"> · run {g.openRun.status}</Text>}
      </Box>
      {activityLine($, e, view, g)}
      <Text dimColor>
        {run ? <Text color={isFailed(run.status) ? 'red' : undefined}>last run {run.status} {ago(run.endedAt ?? run.startedAt, view.now)}</Text> : 'no runs yet'}
        {run && runCost(run) ? ` · ${runCost(run)}` : ''}
        {nextRunText(g, view.now)}
        {g.openItemCount > 0 ? ` · ${g.openItemCount} open` : ''}
      </Text>
      {g.health && (
        <Text>
          <Text color={g.health.passed ? 'green' : 'red'}>{g.health.passed ? 'healthy' : 'failing'}</Text>
          {g.health.value !== null ? ` ${g.health.value}` : ''} <Text dimColor>{spark(g.trend)}</Text>
        </Text>
      )}
      {g.watchFailing && <Text color="red">a watch can't check{isOpen ? '' : ': expand the goal to see why'}</Text>}
      {g.needsYou.map((item) => proposalRow($, e, view, g, item))}
      {g.needsYouCount > g.needsYou.length && (
        <Text dimColor>… and {g.needsYouCount - g.needsYou.length} more waiting: expand the goal ({index < 9 ? index + 1 : 'its name'}) to see them all</Text>
      )}
      {controls($, e, view, g)}
      {isOpen && details($, e, view, g)}
      {g.suggestions.map((s) => autoSuggestion($, e, view, g, s))}
    </Box>
  )
}

/**
 * A category whose proposals were approved every time lately: switch it to
 * auto here, after a second press, since runs then act without asking.
 */
function autoSuggestion($: Engine, e: E, view: View, g: GoalCard, s: GoalCard['suggestions'][number]) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const key = `${g.id}-${s.category}`
  const confirming = view.pending?.kind === 'auto' && view.pending.goalId === g.id && view.pending.category === s.category
  return (
    <Box key={`suggestion-${key}`} flexDirection="column">
      <Text dimColor>Approved every time lately ({s.approvedInARow} in a row): {s.category}</Text>
      {confirming ? (
        <Box flexDirection="column">
          <Text color="yellow">Runs will do {s.category} actions without asking you first. Switch?</Text>
          <Box>
            <Button
              key={`auto-yes-${key}`}
              label={view.doing === `auto:${key}` ? 'Switching…' : 'Yes, switch'}
              onPress={() => {
                void setConfirm($, null)
                void act($, `auto:${key}`, 'switch to auto', async () => void (await updateGoal($, g.id, { autonomy: { [s.category]: 'auto' } })))
              }}
            />
            <Text dimColor> · </Text>
            {action($, e, { key: `auto-no-${key}`, label: 'Keep asking', onPress: () => void setConfirm($, null) })}
          </Box>
        </Box>
      ) : (
        <Box>
          {action($, e, { key: `auto-${key}`, label: `Switch ${s.category} to auto`, onPress: () => void setConfirm($, { kind: 'auto', goalId: g.id, category: s.category }) })}
          <Text dimColor> · </Text>
          <Link key={`autonomy-${key}`} href={`${view.base}/goals/${encodeURIComponent(g.id)}`} label="open the goal page" />
        </Box>
      )}
    </Box>
  )
}

/** One line: what the goal's agent is doing now, or what happens next. */
function activityLine($: Engine, e: E, view: View, g: GoalCard) {
  const { Box, Text } = $.ui.resolve(e)
  const { state, text, at, waiting } = g.activity
  if (!text) return null
  if (state === 'running' && waiting) {
    // Claude Code asks wherever the run's session shows it: say so, as nothing here answers it
    const age = ` · ${ago(waiting.since, view.now)}`
    return (
      <Box key={`activity-${g.id}`} flexDirection="column">
        <Text>
          <Text color="yellow">⏸ {clip(text, Math.max(view.columns - 2 - age.length, 10))}</Text>
          <Text dimColor>{age}</Text>
        </Text>
        {/* Wraps rather than clips: where to answer is the point of the line */}
        <Text dimColor>{permissionWhere(view.mine.includes(g.id), view.standing)}</Text>
      </Box>
    )
  }
  if (state === 'running') {
    const age = at ? ` · ${ago(at, view.now)}` : ''
    return (
      <Text key={`activity-${g.id}`}>
        <Text color="cyan">● {clip(text, Math.max(view.columns - 2 - age.length, 10))}</Text>
        <Text dimColor>{age}</Text>
      </Text>
    )
  }
  return <Text key={`activity-${g.id}`} dimColor>{state === 'queued' ? '◌ ' : ''}{clip(text, Math.max(view.columns - 2, 10))}</Text>
}

function proposalRow($: Engine, e: E, view: View, g: GoalCard, item: GoalCard['needsYou'][number]) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const key = `${g.id}/${item.id}`
  const isFirst = view.first === key
  const sendBack = (text: string) => {
    if (!text.trim()) return
    void act($, `reject:${key}`, 'reject', () => reject($, g.id, item.id, text.trim())).then((ok) => {
      if (ok) void setRejecting($, null)
    })
  }
  const reply = (text: string) => {
    if (!text.trim()) return
    void act($, `answer:${key}`, 'answer', () => answerItem($, g.id, item.id, text.trim())).then((ok) => {
      if (ok) void setRejecting($, null)
    })
  }

  // A run's question or request: answer it, or mark it done (e.g. after connecting a service)
  if (item.asksPerson) {
    return (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Text color="yellow">? {item.title}</Text>
        {view.open === key && Input ? (
          <Box flexDirection="column">
            <Input key={`answer-${key}`} label="Your answer (saved to the goal's memory)" submitLabel="Send" autoFocus onSubmit={reply} />
            {action($, e, { key: `cancel-${key}`, label: 'Cancel', onPress: () => void setRejecting($, null) })}
          </Box>
        ) : (
          <Box>
            <Button key={`answer-btn-${key}`} label="Answer…" variant="primary" hotkey={isFirst ? 'a' : undefined} onPress={() => void setRejecting($, key)} />
            <Text dimColor> · </Text>
            {action($, e, { key: `done-${key}`, label: view.doing === `approve:${key}` ? 'Marking…' : 'Done', onPress: () => void act($, `approve:${key}`, 'mark it done', () => approve($, g.id, item.id)) })}
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text color="yellow">● {item.title}</Text>
      {(item.category || item.summary) && (
        <Text dimColor>
          {'  '}
          {item.category ? `${item.category}: ` : ''}
          {item.summary ?? ''}
        </Text>
      )}
      {view.open === key && Input ? (
        <Box flexDirection="column">
          <Input key={`feedback-${key}`} label="What should change? (saved to the goal's memory)" submitLabel="Send back" autoFocus onSubmit={sendBack} />
          {action($, e, { key: `cancel-${key}`, label: 'Cancel', onPress: () => void setRejecting($, null) })}
        </Box>
      ) : (
        <Box>
          <Button
            key={`approve-${key}`}
            label={view.doing === `approve:${key}` ? 'Approving…' : 'Approve'}
            variant="primary"
            hotkey={isFirst ? 'a' : undefined}
            onPress={() => void act($, `approve:${key}`, 'approve', () => approve($, g.id, item.id))}
          />
          <Text> </Text>
          <Button key={`reject-${key}`} label="Reject…" hotkey={isFirst ? 'r' : undefined} onPress={() => void setRejecting($, key)} />
        </Box>
      )}
    </Box>
  )
}

function controls($: Engine, e: E, view: View, g: GoalCard) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isCancelling = view.pending?.kind === 'cancel-run' && view.pending.goalId === g.id
  const isDeleting = view.pending?.kind === 'delete-goal' && view.pending.goalId === g.id

  if (isDeleting) {
    return (
      <Box key={`controls-${g.id}`} flexDirection="column" marginTop={1}>
        <Text color="yellow">Delete "{g.name}" for good, with its items, runs and memory? This can't be undone.</Text>
        <Box>
          <Button
            key={`delete-yes-${g.id}`}
            label={view.doing === `delete:${g.id}` ? 'Deleting…' : 'Yes, delete'}
            onPress={() => {
              void setConfirm($, null)
              void act($, `delete:${g.id}`, 'delete the goal', () => deleteGoal($, g.id))
            }}
          />
          <Text dimColor> · </Text>
          {action($, e, { key: `delete-no-${g.id}`, label: 'Keep it', onPress: () => void setConfirm($, null) })}
        </Box>
      </Box>
    )
  }

  if (isCancelling) {
    return (
      <Box key={`controls-${g.id}`} marginTop={1}>
        <Text color="yellow">Cancel this run? </Text>
        <Button
          key={`cancel-run-yes-${g.id}`}
          label={view.doing === `cancel:${g.id}` ? 'Cancelling…' : 'Yes, cancel'}
          onPress={() => {
            void setConfirm($, null)
            void act($, `cancel:${g.id}`, 'cancel the run', () => cancelRun($, g.id))
          }}
        />
        <Text> </Text>
        {action($, e, { key: `cancel-run-no-${g.id}`, label: 'Keep running', onPress: () => void setConfirm($, null) })}
      </Box>
    )
  }

  // The buttons that apply, joined by dots so they don't read as one phrase
  const buttons: RenderChildren[] = []
  const run = lastRun(g)
  if (run && isFailed(run.status)) {
    buttons.push(<Button key={`discuss-${g.id}`} label={view.doing === `discuss:${g.id}` ? 'Sending…' : 'Discuss'} onPress={() => void discuss($, g, run)} />)
  }
  if (g.status === 'active' && !g.oneOff) {
    buttons.push(g.schedule ? (
      action($, e, { key: `reschedule-${g.id}`, label: view.doing === `schedule:${g.id}` ? 'Choosing…' : 'Reschedule', onPress: () => void act($, `schedule:${g.id}`, 'change the schedule', () => rescheduleGoal($, g)) })
    ) : (
      action($, e, { key: `schedule-${g.id}`, label: view.doing === `schedule:${g.id}` ? 'Choosing…' : 'Set schedule', onPress: () => void act($, `schedule:${g.id}`, 'set the schedule', async () => void (await chooseSchedule($, g))) })
    ))
  }
  if (canRun(g)) {
    buttons.push(
      action($, e, { key: `run-${g.id}`, label: view.doing === `run:${g.id}` ? 'Starting…' : 'Run now', hotkey: view.runnable === g.id ? 'n' : undefined, onPress: () => void act($, `run:${g.id}`, 'start the run', () => runNow($, g.id)) }),
    )
  }
  if (g.openRun) {
    buttons.push(action($, e, { key: `cancel-run-${g.id}`, label: 'Cancel run', onPress: () => void setConfirm($, ({ kind: 'cancel-run', goalId: g.id })) }))
  }
  buttons.push(g.status === 'active' ? (
    action($, e, { key: `pause-${g.id}`, label: view.doing === `pause:${g.id}` ? 'Pausing…' : 'Pause', onPress: () => void act($, `pause:${g.id}`, 'pause the goal', () => setGoalStatus($, g.id, 'paused')) })
  ) : (
    action($, e, { key: `resume-${g.id}`, label: view.doing === `resume:${g.id}` ? 'Resuming…' : 'Resume', onPress: () => void act($, `resume:${g.id}`, 'resume the goal', () => setGoalStatus($, g.id, 'active')) })
  ))
  if (!g.openRun) {
    // Last, and only without a run going (a run in progress must be cancelled first)
    buttons.push(action($, e, { key: `delete-${g.id}`, label: 'Delete', onPress: () => void setConfirm($, { kind: 'delete-goal', goalId: g.id }) }))
  }

  return (
    <Box key={`controls-${g.id}`} marginTop={g.needsYou.length > 0 ? 1 : 0}>
      {buttons.flatMap((b, i) => (i === 0 ? [b] : [<Text key={`sep-${g.id}-${i}`} dimColor> · </Text>, b]))}
    </Box>
  )
}

function details($: Engine, e: E, view: View, g: GoalCard) {
  const { Box, Text, Button, Link, Input } = $.ui.resolve(e)
  // Discuss opens a box for the person's question, like a to-do's Ask…; Enter on an empty box asks the usual one
  const discussBox = (kind: 'goal' | 'run', id: string, run?: GoalCard['runs'][number]) => (
    <Box key={`discuss-${kind}-box-${id}`} flexDirection="column">
      <Input
        key={`discuss-${kind}-input-${id}`}
        label="Your question"
        placeholder="type a question, or Enter for the usual one"
        submitLabel={view.doing === `discuss:${g.id}` ? 'Sending…' : 'Discuss'}
        autoFocus
        onSubmit={(text: string) => void discuss($, g, run, text)}
      />
      {action($, e, { key: `discuss-${kind}-cancel-${id}`, label: 'Cancel', onPress: () => void setDiscussing($, null) })}
    </Box>
  )
  if (!g.detail) return <Text key={`details-${g.id}`} dimColor>  Loading… (if this stays, collapse some other goals: too many open at once)</Text>
  return (
    <Box key={`details-${g.id}`} flexDirection="column" marginTop={1}>
      <Text dimColor>{g.objective}</Text>
      <Text dimColor>Runs {scheduleLabel(g.schedule)}{g.schedule ? '' : ' (set one with /goal-schedule)'}</Text>
      {modelLine($, e, view, g)}
      {g.watches.map((w) => (
        <Text key={`watch-${g.id}/${w.name}`} dimColor>
          Also runs when "{w.name}" sees something new (checked every {w.everyMinutes} min{w.lastFiredAt ? `, last ${ago(w.lastFiredAt, view.now)}` : ''})
          {w.failing && <Text color="red"> · can't check: {w.error ?? 'the command fails'}</Text>}
        </Text>
      ))}
      {allowSection($, e, view, g)}

      <Text bold>Open items</Text>
      {g.openItems.length === 0 && <Text dimColor>  none</Text>}
      {g.openItems.map((item) => (
        <Text key={`item-${g.id}/${item.id}`}>  · {item.title}</Text>
      ))}
      {g.openItemCount > g.openItems.length && <Text dimColor>  … and {g.openItemCount - g.openItems.length} more</Text>}

      {view.discussing === `goal:${g.id}`
        ? discussBox('goal', g.id)
        : action($, e, { key: `discuss-goal-${g.id}`, label: 'Discuss this goal…', onPress: () => void setDiscussing($, `goal:${g.id}`) })}

      <Text bold>Recent runs</Text>
      {g.runs.length === 0 && <Text dimColor>  none</Text>}
      {g.runs.map((r) => (
        <Box key={`run-${r.id}`} flexDirection="column">
          <Text key={`run-row-${r.id}`}>
            {'  '}
            <Text color={isFailed(r.status) ? 'red' : r.status === 'completed' ? 'green' : 'cyan'}>{r.status}</Text>
            <Text dimColor> {r.trigger} · {ago(r.endedAt ?? r.startedAt, view.now)}{runCost(r) ? ` · ${runCost(r)}` : ''}</Text>
            {r.summary ? ` — ${r.summary}` : ''}
          </Text>
          {r.untrusted && <Text key={`run-untrusted-${r.id}`} dimColor>    Read outside content ({r.untrusted}): auto actions needed approval</Text>}
          {r.status !== 'running' && r.status !== 'queued' && (view.discussing === `run:${r.id}`
            ? discussBox('run', r.id, r)
            : action($, e, { key: `discuss-run-${r.id}`, label: '    Discuss this run…', onPress: () => void setDiscussing($, `run:${r.id}`) })
          )}
        </Box>
      ))}

      <Text bold>Memory</Text>
      {g.memory.length === 0 && <Text dimColor>  none</Text>}
      {g.memory.map((m) => {
        const isConfirming = view.pending?.kind === 'delete-memory' && view.pending.memoryId === m.id
        return (
          <Box key={`memory-${m.id}`}>
            <Text>  {m.pinned ? '📌 ' : ''}{m.untrusted ? <Text color="yellow">⚠ </Text> : null}<Text dimColor>[{m.kind}]</Text> {m.text} </Text>
            {m.untrusted && !isConfirming ? (
              // A run wrote it after reading outside content: runs that read it need approval for auto actions until trusted
              <Box>
                {action($, e, { key: `trust-${m.id}`, label: 'Trust', onPress: () => void act($, `trust:${m.id}`, 'trust the memory', () => trustMemory($, g.id, m.id)) })}
                <Text> </Text>
              </Box>
            ) : null}
            {isConfirming ? (
              <Box>
                {action($, e, { key: `forget-yes-${m.id}`, label: 'Delete it', onPress: () => {
                    void setConfirm($, null)
                    void act($, `forget:${m.id}`, 'delete the memory', () => deleteMemory($, g.id, m.id))
                  } })}
                <Text> </Text>
                {action($, e, { key: `forget-no-${m.id}`, label: 'Keep', onPress: () => void setConfirm($, null) })}
              </Box>
            ) : (
              action($, e, { key: `forget-${m.id}`, label: 'Delete', onPress: () => void setConfirm($, ({ kind: 'delete-memory', goalId: g.id, memoryId: m.id })) })
            )}
          </Box>
        )
      })}

      <Link key={`open-${g.id}`} href={`${view.base}/goals/${encodeURIComponent(g.id)}`} label="Open in browser" />
    </Box>
  )
}

const DONE_SECTION = '__done__'

/** Done one-off goals, collapsed: each with its last run's summary and Run again. */
function doneSection($: Engine, e: E, view: View, done: GoalCard[]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isOpen = view.shown.includes(DONE_SECTION)
  return (
    <Box key="done" flexDirection="column" marginBottom={1}>
      <Button key="done-toggle" plain label={`${isOpen ? '▾' : '▸'} Done (${done.length})`} onPress={() => void toggleExpanded($, DONE_SECTION)} />
      {isOpen && done.map((g) => {
        const run = lastRun(g)
        return (
          <Box key={`done-${g.id}`} flexDirection="column">
            <Box>
              <Text>  ✓ {g.name}</Text>
              <Text dimColor> · {run ? ago(run.endedAt ?? run.startedAt, view.now) : 'never run'} </Text>
              {action($, e, { key: `again-${g.id}`, label: view.doing === `run:${g.id}` ? 'Starting…' : 'Run again', onPress: () => void act($, `run:${g.id}`, 'run it again', () => runNow($, g.id)) })}
            </Box>
            {run?.summary && <Text dimColor>    {clip(run.summary, Math.max(view.columns - 4, 10))}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The person's to-do lists, each collapsed to its name and open count. Open,
 * a list shows its to-dos: ☐ ticks one off, pressing the text expands it (the
 * full text, Ask…, Plan and Start), and "n done" shows the ticked ones, each of
 * which goes back on the list when pressed. Ask… opens a box for the person's
 * question; Enter on an empty box asks for Claude's opinion.
 */
function todoSection($: Engine, e: E, view: View, todos: Todos, addingTo: string | null, askingAbout: string | null, editing: string | null) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  return (
    <Box key="todos" flexDirection="column" marginBottom={1}>
      {todos.lists.map((list) => {
        const key = `todo:${list.id}`
        const isOpen = view.shown.includes(key)
        const doneKey = `todo-done:${list.id}`
        const showDone = view.shown.includes(doneKey)
        const isDone = (i: TodoItem) => i.status === 'completed' || i.status === 'abandoned'
        const open = list.items.filter((i) => !isDone(i))
        const done = list.items.filter(isDone)
        return (
          <Box key={key} flexDirection="column">
            <Button key={`todo-toggle-${list.id}`} plain label={`${isOpen ? '▾' : '▸'} ${list.name} (${list.open} to do)`} onPress={() => void toggleExpanded($, key)} />
            {isOpen && open.map((item) => {
              const itemKey = `todo-item:${list.id}/${item.id}`
              const expanded = view.shown.includes(itemKey)
              const indent = '  '.repeat(item.depth + 1)
              return (
                <Box key={`todo-${list.id}/${item.id}`} flexDirection="column">
                  <Box>
                    <Text>{indent}</Text>
                    <Button key={`todo-tick-${list.id}/${item.id}`} plain label={item.status === 'active' ? '◐' : '☐'} onPress={() => void toggleTodo($, list, item)} />
                    <Text> </Text>
                    <Button
                      key={`todo-open-${list.id}/${item.id}`}
                      plain
                      label={`${item.id} ${expanded ? '▾' : clip(item.text, Math.max(view.columns - 8 - item.id.length - item.depth * 2, 10))}`}
                      onPress={() => void toggleExpanded($, itemKey)}
                    />
                  </Box>
                  {expanded && (
                    <Box flexDirection="column">
                      {editing === `${list.id}/${item.id}` ? (
                        <Box flexDirection="column">
                          <Input
                            key={`todo-edit-input-${list.id}/${item.id}`}
                            label="To-do"
                            value={item.text}
                            submitLabel={view.doing === `todo-edit:${list.id}/${item.id}` ? 'Saving…' : 'Save'}
                            autoFocus
                            onSubmit={(text: string) => void editFromPane($, list, item, text)}
                          />
                          {action($, e, { key: `todo-edit-cancel-${list.id}/${item.id}`, label: 'Cancel', onPress: () => void setEditingTodo($, null) })}
                        </Box>
                      ) : (
                        <Text>{indent}    {item.text}</Text>
                      )}
                      {item.notes && <Text dimColor>{indent}    {item.notes}</Text>}
                      {editing === `${list.id}/${item.id}` ? null : askingAbout === `${list.id}/${item.id}` ? (
                        <Box flexDirection="column">
                          <Input
                            key={`todo-ask-input-${list.id}/${item.id}`}
                            label="Your question"
                            placeholder="type a question, or Enter for my opinion"
                            submitLabel={view.doing === `todo-ask:${list.id}/${item.id}` ? 'Asking…' : 'Ask'}
                            autoFocus
                            onSubmit={(text: string) => void askFromPane($, list, item, text)}
                          />
                          {action($, e, { key: `todo-ask-cancel-${list.id}/${item.id}`, label: 'Cancel', onPress: () => void setAskingAbout($, null) })}
                        </Box>
                      ) : (
                      <Box>
                        <Text>{indent}    </Text>
                        {action($, e, { key: `todo-ask-${list.id}/${item.id}`, label: 'Ask…', onPress: () => void setAskingAbout($, `${list.id}/${item.id}`) })}
                        <Text> </Text>
                        <Button key={`todo-plan-${list.id}/${item.id}`} label={view.doing === `todo-plan:${list.id}/${item.id}` ? 'Sending…' : 'Plan'} onPress={() => void workFromPane($, list, item, 'plan')} />
                        <Text> </Text>
                        {action($, e, { key: `todo-start-${list.id}/${item.id}`, label: view.doing === `todo-start:${list.id}/${item.id}` ? 'Sending…' : 'Start', onPress: () => void workFromPane($, list, item, 'start') })}
                        <Text> </Text>
                        {action($, e, { key: `todo-edit-${list.id}/${item.id}`, label: 'Edit', onPress: () => void setEditingTodo($, `${list.id}/${item.id}`) })}
                      </Box>
                      )}
                    </Box>
                  )}
                </Box>
              )
            })}
            {isOpen && done.length > 0 && (
              <Button key={`todo-done-toggle-${list.id}`} plain label={`  ${showDone ? '▾' : '▸'} ${done.length} done`} onPress={() => void toggleExpanded($, doneKey)} />
            )}
            {isOpen && showDone && done.map((item) => (
              <Button
                key={`todo-untick-${list.id}/${item.id}`}
                plain
                label={`    ☑ ${item.id} ${clip(item.text, Math.max(view.columns - 10 - item.id.length, 10))}`}
                onPress={() => void toggleTodo($, list, item)}
              />
            ))}
            {/* The add box opens on demand, already focused, like Reject's feedback box */}
            {isOpen && addingTo === list.id ? (
              <Box flexDirection="column">
                <Input
                  key={`todo-add-${list.id}`}
                  label="New to-do"
                  placeholder="type it, then Enter"
                  submitLabel="Add"
                  autoFocus
                  onSubmit={(text: string) => {
                    if (!text.trim()) return
                    void addFromPane($, todos.dir, list, text.trim()).then((ok) => {
                      if (ok) void setAddingTo($, null)
                    })
                  }}
                />
                {action($, e, { key: `todo-add-cancel-${list.id}`, label: 'Cancel', onPress: () => void setAddingTo($, null) })}
              </Box>
            ) : isOpen ? (
              action($, e, { key: `todo-addbtn-${list.id}`, label: '  + Add', onPress: () => void setAddingTo($, list.id) })
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The Claude Code allow rules for a goal's auto tools, one line until opened.
 * The guard never allows a call, so without these Claude Code asks before each
 * one (unless the session is in auto mode). Claude adds them only after the
 * person's yes: the mod itself never writes settings.
 */
/**
 * "Model: Sonnet · Change…". When the last run used another model (the
 * setting changed since, or CLAUDE_CODE_SUBAGENT_MODEL overrides every
 * subagent's), it says which, so the setting never claims more than it does.
 */
function modelLine($: Engine, e: E, view: View, g: GoalCard) {
  const { Box, Text } = $.ui.resolve(e)
  const used = lastRun(g)?.model ?? null
  const differs = used !== null && g.model !== null && !sameModel(g.model, used)
  return (
    <Box key={`model-${g.id}`}>
      <Text dimColor>{`Model: ${goalModelLabel(g.model)} · `}</Text>
      {action($, e, { key: `model-change-${g.id}`, label: view.doing === `model:${g.id}` ? 'Choosing…' : 'Change…', onPress: () => void act($, `model:${g.id}`, 'change the model', () => chooseModel($, g)) })}
      {differs && <Text color="yellow"> (last run used {modelName(used)})</Text>}
    </Box>
  )
}

/** A goal's model setting (an alias or an id) and the id a run reported, as the same model. */
function sameModel(setting: string, used: string): boolean {
  const s = setting.toLowerCase()
  const u = used.toLowerCase()
  return s === u || (!s.includes('-') && u.includes(s)) || u.startsWith(s)
}

/** The pane's model picker: four choices, or a full id typed under Other. A dismissed question changes nothing. */
async function chooseModel($: Engine, g: GoalCard): Promise<void> {
  let answer: string | null = null
  try {
    answer = await $.ui.ask(
      `Which model should "${g.name}" run on? Now: ${goalModelLabel(g.model)}. Smaller models cost less and suit routine work; pick a larger one if its runs miss things. Or type a full model id under Other.`,
      MODEL_CHOICES.map((c) => c.label),
    )
  } catch {
    answer = null
  }
  const read = readModelAnswer(answer)
  if (!read || read.model === g.model) {
    $.ui.toast(`${g.name}: model unchanged.`)
    return
  }
  await updateGoal($, g.id, { model: read.model }) // the server refuses a name that can't be a model
  $.ui.toast(`${g.name} now runs on ${goalModelLabel(read.model)}.`)
}

function allowSection($: Engine, e: E, view: View, g: GoalCard) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { rules, skipped } = allowRules(g)
  if (rules.length === 0 && skipped.length === 0) return null
  const key = `rules:${g.id}`
  const isOpen = view.shown.includes(key)
  return (
    <Box key={`allow-${g.id}`} flexDirection="column">
      <Button key={`allow-toggle-${g.id}`} plain label={`${isOpen ? '▾' : '▸'} Claude Code allow rules (${rules.length})`} onPress={() => void toggleExpanded($, key)} />
      {isOpen && <Text key={`allow-why-${g.id}`} dimColor>  For the tools this goal may use without asking. Without them Claude Code asks before each call, unless it is in auto mode. They apply to all of Claude Code, not only goal runs.</Text>}
      {isOpen && rules.map((r) => <Text key={`allow-rule-${g.id}/${r}`}>{`  ${r}`}</Text>)}
      {isOpen && skipped.length > 0 && <Text key={`allow-skipped-${g.id}`} dimColor>  Claude Code can't take these tool rules as allow rules: {skipped.join(', ')}</Text>}
      {isOpen && rules.length > 0 && action($, e, { key: `allow-ask-${g.id}`, label: view.doing === `allow:${g.id}` ? '  Asking…' : '  Ask Claude to add them', onPress: () => void askToAllow($, g, rules) })}
    </Box>
  )
}

/** Asks Claude, in the conversation, to add the allow rules: it shows the change and waits for the person's yes. */
async function askToAllow($: Engine, g: GoalCard, rules: string[]): Promise<boolean> {
  return act($, `allow:${g.id}`, 'ask Claude to add the allow rules', async () => void (await sendToChat($, allowRulesPrompt(g, rules), `add the Claude Code allow rules for goal "${g.name}" (${g.id})`)))
}

/** Asks Claude, in the conversation, to install the published update. */
async function askToUpdate($: Engine, update: Update): Promise<boolean> {
  return act($, 'update-install', 'ask Claude to update', async () => void (await sendToChat($, updatePrompt(update), `install Quarterdeck ${update.latest}: claude plugin update quarterdeck-goals@quarterdeck`)))
}

/**
 * Discuss: the goal, or one of its runs, brought into the conversation to talk
 * over (and change), with the person's question when they typed one in the
 * box. Closes the box once sent.
 */
async function discuss($: Engine, g: GoalCard, run?: GoalCard['runs'][number], question?: string): Promise<boolean> {
  const asked = question?.trim()
  const about = run ? `about run ${run.id} of goal "${g.name}" (${g.id})` : `about goal "${g.name}" (${g.id})`
  const aside = asked ? `${about}: ${asked}` : about
  const ok = await act($, `discuss:${g.id}`, 'start the discussion', async () => void (await sendToChat($, discussPrompt(g, run, asked), aside)))
  if (ok) await setDiscussing($, null)
  return ok
}
