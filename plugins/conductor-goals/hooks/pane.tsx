/**
 * The Goals pane: one card per goal with its proposals (Approve / Reject),
 * controls (Run now, Pause / Resume, Cancel run) and, expanded, its open
 * items, recent runs and memory.
 *
 * Hotkeys while the pane has focus: a / r approve or reject the first
 * proposal, n runs the first goal that can run, g refreshes, 1–9 expand a goal.
 */
import type { EngineInterface, RenderInput } from 'claude-code'

import type { Confirm, GoalCard, TodoItem, Todos } from '../types'
import { approve, baseUrl, deleteMemory, reject, runNow, setGoalStatus } from './api'
import { cancelRun } from './runner'
import { chooseSchedule } from './schedule'
import { ago, clip, isFailed, lastRun, nextRunText, scheduleLabel, spark } from './model'
import { getBusy, getConfirm, getExpanded, getGuardMissing, getNotice, getRejecting, getSnapshot, getTodos, setConfirm, setRejecting, toggleExpanded } from './state'
import { addFromPane, askFromPane, toggleTodo, workFromPane } from './todos'
import { GUARD_MISSING } from './runner'
import { act, refresh } from './sync'

type $ = EngineInterface
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
  /** The first proposal in the pane, which a / r act on. */
  first: string | null
  /** The goal n runs. */
  runnable: string | null
}

function canRun(g: GoalCard): boolean {
  return g.status === 'active' && !g.openRun
}

export async function renderPane($: $, e: E) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await getSnapshot($)
  const message = await getNotice($)
  const guardMissing = await getGuardMissing($)
  const todos = await getTodos($)

  if (!s.reachable && s.goals.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>Conductor isn't connected.</Text>
        <Text dimColor>Add the conductor MCP server to .mcp.json (see Conductor's README), then reconnect it with /mcp.</Text>
        {s.error && <Text dimColor>{s.error}</Text>}
        <Button key="retry" label="Retry" hotkey="g" onPress={() => void refresh($)} />
      </Box>
    )
  }

  // Done one-offs (retired) go in their own section at the bottom
  const current = s.goals.filter((g) => g.status !== 'retired')
  const done = s.goals.filter((g) => g.status === 'retired')
  const firstWithProposal = current.find((g) => g.needsYou.length > 0)
  const view: View = {
    now: await $.clock.now(),
    columns: e.props.bodyColumns,
    base: await baseUrl($),
    doing: await getBusy($),
    open: await getRejecting($),
    shown: await getExpanded($),
    pending: await getConfirm($),
    first: firstWithProposal ? `${firstWithProposal.id}/${firstWithProposal.needsYou[0]!.id}` : null,
    runnable: current.find(canRun)?.id ?? null,
  }

  return (
    <Box flexDirection="column">
      {guardMissing && <Text color="yellow">{GUARD_MISSING}</Text>}
      {!s.reachable && <Text color="yellow">Offline — showing the last read ({ago(new Date(s.fetchedAt).toISOString(), view.now)}).</Text>}
      {current.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>No goals yet.</Text>
          <Text dimColor>Create one with /goal-new &lt;objective&gt;, or in the web app.</Text>
        </Box>
      )}
      {current.map((g, i) => goalCard($, e, view, g, i))}
      {todos && todos.lists.length > 0 && todoSection($, e, view, todos)}
      {done.length > 0 && doneSection($, e, view, done)}
      {message && <Text color="red">{message}</Text>}
      <Box>
        <Text dimColor>Updated {ago(new Date(s.fetchedAt).toISOString(), view.now)} </Text>
        <Button key="refresh" label="Refresh" plain hotkey="g" onPress={() => void refresh($)} />
      </Box>
    </Box>
  )
}

function goalCard($: $, e: E, view: View, g: GoalCard, index: number) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const isOpen = view.shown.includes(g.id)
  const run = lastRun(g)
  const toggle = () => void toggleExpanded($, g.id)

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
        {nextRunText(g, view.now)}
        {g.openItemCount > 0 ? ` · ${g.openItemCount} open` : ''}
      </Text>
      {g.health && (
        <Text>
          <Text color={g.health.passed ? 'green' : 'red'}>{g.health.passed ? 'healthy' : 'failing'}</Text>
          {g.health.value !== null ? ` ${g.health.value}` : ''} <Text dimColor>{spark(g.trend)}</Text>
        </Text>
      )}
      {g.needsYou.map((item) => proposalRow($, e, view, g, item))}
      {controls($, e, view, g)}
      {isOpen && details($, e, view, g)}
      {g.suggestions.length > 0 && (
        <Box>
          <Text dimColor>
            Approved every time lately: {g.suggestions.map((x) => x.category).join(', ')}. Consider switching to auto{' '}
          </Text>
          <Link key={`autonomy-${g.id}`} href={`${view.base}/goals/${encodeURIComponent(g.id)}`} label="on the goal page" />
        </Box>
      )}
    </Box>
  )
}

/** One line: what the goal's agent is doing now, or what happens next. */
function activityLine($: $, e: E, view: View, g: GoalCard) {
  const { Text } = $.ui.resolve(e)
  const { state, text, at } = g.activity
  if (!text) return null
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

function proposalRow($: $, e: E, view: View, g: GoalCard, item: GoalCard['needsYou'][number]) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const key = `${g.id}/${item.id}`
  const isFirst = view.first === key
  const sendBack = (text: string) => {
    if (!text.trim()) return
    void act($, `reject:${key}`, 'reject', () => reject($, g.id, item.id, text.trim())).then((ok) => {
      if (ok) void setRejecting($, null)
    })
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
          <Button key={`cancel-${key}`} label="Cancel" plain onPress={() => void setRejecting($, null)} />
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

function controls($: $, e: E, view: View, g: GoalCard) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const isCancelling = view.pending?.kind === 'cancel-run' && view.pending.goalId === g.id

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
        <Button key={`cancel-run-no-${g.id}`} label="Keep running" plain onPress={() => void setConfirm($, null)} />
      </Box>
    )
  }

  return (
    <Box key={`controls-${g.id}`} marginTop={g.needsYou.length > 0 ? 1 : 0}>
      {g.status === 'active' && !g.schedule && !g.oneOff && (
        <Button
          key={`schedule-${g.id}`}
          label={view.doing === `schedule:${g.id}` ? 'Choosing…' : 'Set schedule'}
          plain
          onPress={() => void act($, `schedule:${g.id}`, 'set the schedule', async () => void (await chooseSchedule($, g)))}
        />
      )}
      {canRun(g) && (
        <Button
          key={`run-${g.id}`}
          label={view.doing === `run:${g.id}` ? 'Starting…' : 'Run now'}
          plain
          hotkey={view.runnable === g.id ? 'n' : undefined}
          onPress={() => void act($, `run:${g.id}`, 'start the run', () => runNow($, g.id))}
        />
      )}
      {g.openRun && (
        <Button key={`cancel-run-${g.id}`} label="Cancel run" plain onPress={() => void setConfirm($, ({ kind: 'cancel-run', goalId: g.id }))} />
      )}
      <Text> </Text>
      {g.status === 'active' ? (
        <Button key={`pause-${g.id}`} label={view.doing === `pause:${g.id}` ? 'Pausing…' : 'Pause'} plain onPress={() => void act($, `pause:${g.id}`, 'pause the goal', () => setGoalStatus($, g.id, 'paused'))} />
      ) : (
        <Button key={`resume-${g.id}`} label={view.doing === `resume:${g.id}` ? 'Resuming…' : 'Resume'} plain onPress={() => void act($, `resume:${g.id}`, 'resume the goal', () => setGoalStatus($, g.id, 'active'))} />
      )}
    </Box>
  )
}

function details($: $, e: E, view: View, g: GoalCard) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  return (
    <Box key={`details-${g.id}`} flexDirection="column" marginTop={1}>
      <Text dimColor>{g.objective}</Text>
      <Text dimColor>Runs {scheduleLabel(g.schedule)}{g.schedule ? '' : ' (set one with /goal-schedule)'}</Text>

      <Text bold>Open items</Text>
      {g.openItems.length === 0 && <Text dimColor>  none</Text>}
      {g.openItems.map((item) => (
        <Text key={`item-${g.id}/${item.id}`}>  · {item.title}</Text>
      ))}
      {g.openItemCount > g.openItems.length && <Text dimColor>  … and {g.openItemCount - g.openItems.length} more</Text>}

      <Text bold>Recent runs</Text>
      {g.runs.length === 0 && <Text dimColor>  none</Text>}
      {g.runs.map((r) => (
        <Text key={`run-row-${r.id}`}>
          {'  '}
          <Text color={isFailed(r.status) ? 'red' : r.status === 'completed' ? 'green' : 'cyan'}>{r.status}</Text>
          <Text dimColor> {r.trigger} · {ago(r.endedAt ?? r.startedAt, view.now)}</Text>
          {r.summary ? ` — ${r.summary}` : ''}
        </Text>
      ))}

      <Text bold>Memory</Text>
      {g.memory.length === 0 && <Text dimColor>  none</Text>}
      {g.memory.map((m) => {
        const isConfirming = view.pending?.kind === 'delete-memory' && view.pending.memoryId === m.id
        return (
          <Box key={`memory-${m.id}`}>
            <Text>  {m.pinned ? '📌 ' : ''}<Text dimColor>[{m.kind}]</Text> {m.text} </Text>
            {isConfirming ? (
              <Box>
                <Button
                  key={`forget-yes-${m.id}`}
                  label="Delete it"
                  plain
                  onPress={() => {
                    void setConfirm($, null)
                    void act($, `forget:${m.id}`, 'delete the memory', () => deleteMemory($, g.id, m.id))
                  }}
                />
                <Text> </Text>
                <Button key={`forget-no-${m.id}`} label="Keep" plain onPress={() => void setConfirm($, null)} />
              </Box>
            ) : (
              <Button key={`forget-${m.id}`} label="Delete" plain onPress={() => void setConfirm($, ({ kind: 'delete-memory', goalId: g.id, memoryId: m.id }))} />
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
function doneSection($: $, e: E, view: View, done: GoalCard[]) {
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
              <Button
                key={`again-${g.id}`}
                label={view.doing === `run:${g.id}` ? 'Starting…' : 'Run again'}
                plain
                onPress={() => void act($, `run:${g.id}`, 'run it again', () => runNow($, g.id))}
              />
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
 * full text, Ask, Plan and Start), and "n done" shows the ticked ones, each of
 * which goes back on the list when pressed.
 */
function todoSection($: $, e: E, view: View, todos: Todos) {
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
                      <Text>{indent}    {item.text}</Text>
                      {item.notes && <Text dimColor>{indent}    {item.notes}</Text>}
                      <Box>
                        <Text>{indent}    </Text>
                        <Button key={`todo-ask-${list.id}/${item.id}`} plain label={view.doing === `todo-ask:${list.id}/${item.id}` ? 'Asking…' : 'Ask'} onPress={() => void askFromPane($, list, item)} />
                        <Text> </Text>
                        <Button key={`todo-plan-${list.id}/${item.id}`} label={view.doing === `todo-plan:${list.id}/${item.id}` ? 'Sending…' : 'Plan'} onPress={() => void workFromPane($, list, item, 'plan')} />
                        <Text> </Text>
                        <Button key={`todo-start-${list.id}/${item.id}`} plain label={view.doing === `todo-start:${list.id}/${item.id}` ? 'Sending…' : 'Start'} onPress={() => void workFromPane($, list, item, 'start')} />
                      </Box>
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
            {isOpen && Input && (
              <Input key={`todo-add-${list.id}`} label="Add a to-do" submitLabel="Add" onSubmit={(text: string) => { if (text.trim()) void addFromPane($, todos.dir, list, text.trim()) }} />
            )}
          </Box>
        )
      })}
    </Box>
  )
}
