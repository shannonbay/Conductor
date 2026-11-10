/**
 * Ready-made goals: what typing /goal-new alone offers. Each comes with its
 * instructions, schedule, autonomy and tool rules, so approvals work from the
 * first run (a tool rule is what lets an approved action through Claude Code's
 * own check). Nothing here depends on the person's own setup beyond the
 * connectors named in `needs`.
 */
import type { Schedule } from '../types'

export type Template = {
  /** The choice in /goal-new's question (keep it short). */
  label: string
  name: string
  objective: string
  instructions: string
  schedule: Schedule
  autonomy: Record<string, 'off' | 'propose' | 'auto'>
  tool_map: Record<string, string>
  /** What the goal needs in Claude Code, said once it's created. */
  needs: string
  /**
   * A question whose answer goes before the instructions: `fill` turns a typed
   * answer into text; choosing `later` puts `laterText` there instead.
   */
  ask?: { question: string; later: string; laterText: string; fill: (answer: string) => string }
  /** Also ask for a CV, to rank results against (the job scan). */
  cv?: boolean
}

const DAY = 1440

/** Tool rules for Gmail tools, whichever Gmail connector or server the session has. */
function gmail(rules: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(rules).flatMap(([tool, category]) => [
    [`mcp__*Gmail*__${tool}`, category],
    [`mcp__*gmail*__${tool}`, category],
  ]))
}

export const TEMPLATES: Template[] = [
  {
    label: 'Unsubscribe from mailing lists',
    name: 'Unsubscribe Stale Mailing Lists',
    objective: "Unsubscribe from mailing lists I no longer read, and clear their mail from my inbox",
    instructions: [
      'A sender is stale when its mail has a List-Unsubscribe header and none of its messages from the last 60 days has been opened, with at least 3 messages in that time.',
      'Never unsubscribe from or delete mail from banks, receipts or orders, or anything marked important.',
      'Propose one item per stale sender (external_ref gmail-sender:<address>), saying the sender, how many messages, and when one was last opened.',
      'Continue the scan where the last run stopped (keep where you got to in memory) until the last 60 days are covered.',
      "Before unsubscribing, confirm the sender's latest message has a List-Unsubscribe header; if it has none, abandon the item with that reason.",
      'To unsubscribe: if the message has List-Unsubscribe-Post: List-Unsubscribe=One-Click and an https link, use unsubscribe_one_click with that link (no browser). Otherwise, email the List-Unsubscribe mailto address if it has one. Only if neither works, open the List-Unsubscribe link in Chrome and confirm on that page; never browse anywhere else.',
      'If Chrome asks for permission to use a site, or a sender can only be unsubscribed by hand, ask me (add_item with ask_person, with the link).',
      "Delete means move to the bin, never delete permanently. When a sender's unsubscribe and clean-up are done, complete its item.",
    ].join(' '),
    schedule: { kind: 'interval', minutes: DAY },
    autonomy: { 'email.unsubscribe': 'propose', 'email.delete': 'propose', 'email.send': 'off' },
    tool_map: {
      'mcp__quarterdeck__unsubscribe_one_click': 'email.unsubscribe',
      'mcp__claude-in-chrome__*': 'email.unsubscribe',
      ...gmail({ send_message: 'email.unsubscribe', 'trash_*': 'email.delete', 'mark_*_spam': 'email.delete', reply: 'email.send', forward: 'email.send' }),
    },
    needs: "the Gmail connector (connect it with /mcp). Most senders unsubscribe in one click with no browser; for the rest it uses Claude in Chrome (which asks before each new site) or asks you to do it",
  },
  {
    label: 'Weekly job scan',
    name: 'Weekly Job Scan',
    objective: "Once a week, find new job ads that match what I'm looking for and tell me the top three",
    instructions: '',
    schedule: { kind: 'interval', minutes: 7 * DAY },
    autonomy: { 'email.send': 'propose' },
    tool_map: gmail({ send_message: 'email.send', reply: 'email.send', forward: 'email.send' }),
    needs: 'Claude in Chrome or web access to search job sites; the Gmail connector only if you want the top 3 emailed',
    cv: true,
    ask: {
      question: "What jobs should I look for? Type it under Other: the role, location, minimum pay and job sites, e.g. senior software engineer, Wellington or remote, $140k+, on seek.co.nz and LinkedIn.",
      later: 'Ask me in the first run',
      laterText: '', // set below: ASK_LATER is declared after the templates
      fill: (answer) => [
        `What I'm looking for: ${answer}.`,
        'Each run, search the job sites named (or the main ones for that location) for ads from the last week, skip ads you have already reported (keep their ids in memory), and pick the 3 that fit best.',
        'Put them in your end_run summary (title, employer, link and why each fits), so they show in the Goals pane.',
        'If the Gmail connector is available and you know my address, also propose one email.send item with the top 3; send it once I approve.',
        'Never apply for a job or contact an employer.',
      ].join(' '),
    },
  },
  {
    label: 'Tidy my Downloads',
    name: 'Tidy Downloads',
    objective: 'Delete installers older than 30 days from my Downloads folder',
    instructions: [
      'Look in my Downloads folder (top level only) for installers (.exe, .msi, .msix, .dmg, .pkg, .deb, .rpm, .AppImage) last changed more than 30 days ago.',
      'Propose one file.delete item per file (external_ref file:<full path>), with its size and date.',
      'Once approved, move it to the Recycle Bin or Trash, never delete permanently, and complete the item.',
      "Leave anything that isn't an installer alone.",
    ].join(' '),
    schedule: { kind: 'interval', minutes: 7 * DAY },
    autonomy: { 'file.delete': 'propose' },
    tool_map: {},
    needs: 'nothing extra',
  },
  {
    label: 'Inbox triage',
    name: 'Inbox Triage',
    objective: 'Keep my inbox down to what needs me: archive newsletters and notifications, and tell me what matters',
    instructions: [
      'Each run, look at inbox mail that arrived since the last run.',
      "Archive newsletters, promotions and automatic notifications I don't need to act on: propose one email.archive item per sender or kind, saying how many messages; once approved, archive them (remove the INBOX label) and complete the item.",
      'Never delete or send mail.',
      'In your end_run summary, list what looks like it needs a reply or action from me, with sender and subject.',
    ].join(' '),
    schedule: { kind: 'interval', minutes: 360 },
    autonomy: { 'email.archive': 'propose', 'email.delete': 'off', 'email.send': 'off' },
    tool_map: gmail({
      'label_*': 'email.archive', 'unlabel_*': 'email.archive', update_message_labels: 'email.archive',
      'trash_*': 'email.delete', 'mark_*_spam': 'email.delete',
      send_message: 'email.send', reply: 'email.send', forward: 'email.send',
    }),
    needs: 'the Gmail connector (connect it with /mcp)',
  },
  {
    label: 'Keep my GitHub profile current',
    name: 'GitHub Profile',
    objective: "Keep my GitHub profile README up to date with what I've been building",
    instructions: '', // set below: GITHUB_PROFILE
    schedule: { kind: 'interval', minutes: 7 * DAY },
    autonomy: { 'profile.readme_edit': 'propose' },
    tool_map: {},
    needs: "the GitHub CLI, gh (the first run installs it if it's missing; you sign in once with gh auth login)",
    ask: {
      question: "Where is your profile README checked out (the <username>/<username> repo)? Type its path under Other, or I'll find it or clone it.",
      later: 'Find or clone it',
      laterText: '', // set below: GITHUB_FIND
      fill: (answer) => `My profile README repo is checked out at ${answer}.`,
    },
  },
]

/** How many templates the first question shows; the rest are behind "More…" (a question holds 4 choices). */
export const FIRST_CHOICES = 3
export const MORE = 'More…'

/** The GitHub profile template's standing instructions, after where the repo is. */
export const GITHUB_PROFILE = [
  'Each run, check my recent public activity with gh (my repos sorted by last push, and my public events) since the last run.',
  "When something notable happened in one of my own projects (a release, a new project, a big feature), propose one profile.readme_edit item with the exact new text for the README; once approved, edit the README, commit and push it, and complete the item.",
  "Only my own projects: small contributions to other people's projects don't belong on the profile. Never change other files or other repos.",
  "If gh isn't installed, install it for this user only (winget --scope user, brew or apt). If gh isn't signed in, ask me (add_item with ask_person) to run gh auth login, and carry on next run.",
  'Keep a memory of what the profile already covers, so you never propose the same thing twice.',
].join(' ')

/** Where the repo is, when the person asked to have it found. */
export const GITHUB_FIND = "Find my profile README repo (<username>/<username>, with gh api user for my username) checked out on this computer; if there's none, clone it next to my other repos. Say in your summary where it is."


/** The optional CV question: find the latest one, a path typed under Other, or skip. */
export const CV_QUESTION = 'Where is your CV? With it, I rank jobs against your experience. Type its path under Other, or let me find the latest one.'
export const CV_FIND = 'Find my latest CV'
export const CV_SKIP = 'Skip'

const PROFILE = 'Read it and save a short profile as one memory starting "CV profile:" (under 800 characters: skills, seniority, the kinds of roles that fit, and what to avoid; no contact details, no address). Rank ads against that profile, and say in "why it fits" which of my experience matches. Note the CV file and its last-modified date in the profile, and read it again when the file changes.'

/** What the instructions add for the CV answer; empty when skipped. */
export function cvInstructions(answer: string): string {
  if (answer === CV_FIND) {
    return `My CV: in your first run, find my most recent CV in my Documents folder (then Desktop and Downloads if there's none): a .pdf, .docx or .md file named like CV, resume or résumé, the newest one. Say in your summary which file you used. ${PROFILE}`
  }
  if (answer === CV_SKIP || !answer.trim()) return ''
  return `My CV is at ${answer.trim()}. ${PROFILE}`
}

/** The instructions for a job scan whose criteria the person will give later. */
export const ASK_LATER = [
  "What I'm looking for: not set yet.",
  'If my CV is available, work it out from my CV profile (the roles that fit, at my level, near where I live or remote) and scan in your first run anyway: put the top 3 in your summary, say what you assumed, and add one item asking me to confirm or correct the role, location, minimum pay and job sites.',
  'Without a CV, add that item and wait for my answer before scanning.',
  'Each run, search the job sites (the main ones for the location if none are named) for ads from the last week, skip ads you have already reported (keep their ids in memory), and put the 3 that fit best in your end_run summary (title, employer, link and why each fits).',
  'Never apply for a job or contact an employer.',
].join(' ') + " I'll answer by discussing this goal."

// Texts declared after the list, put in place
const jobScan = TEMPLATES.find((t) => t.name === 'Weekly Job Scan')!
jobScan.ask!.laterText = ASK_LATER
const github = TEMPLATES.find((t) => t.name === 'GitHub Profile')!
github.instructions = GITHUB_PROFILE
github.ask!.laterText = GITHUB_FIND
