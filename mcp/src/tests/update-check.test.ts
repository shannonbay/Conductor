import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CHECK_EVERY_MS, RETRY_AFTER_MS, createUpdateCheck, installedVersion, isNewer } from '../update-check.js'
import { goals_overview, overviewAnswer } from '../tools/goal_runner.js'

describe('isNewer', () => {
  it('compares versions by number, not as text', () => {
    expect(isNewer('0.15.0', '0.16.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(true)
    expect(isNewer('0.15.0', '0.15.0')).toBe(false)
    expect(isNewer('0.16.0', '0.15.9')).toBe(false)
    expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0-beta.1')).toBe(false)
    expect(isNewer('unknown', '1.0.0')).toBe(false)
  })
})

describe('the update check', () => {
  function setup(installed: string | null, answers: (string | null | Error)[]) {
    let now = 1_000_000
    let fetches = 0
    const check = createUpdateCheck({
      installed,
      now: () => now,
      fetchLatest: async () => {
        const a = answers[Math.min(fetches++, answers.length - 1)]
        if (a instanceof Error) throw a
        return a ?? null
      },
    })
    return { check, fetches: () => fetches, advance: (ms: number) => { now += ms } }
  }

  it('reports a newer published version once the check has answered, without waiting for it', async () => {
    const t = setup('0.15.0', ['0.16.0'])
    expect(t.check.available()).toBeNull() // the first call only starts the check
    await t.check.check()
    expect(t.check.available()).toEqual({ installed: '0.15.0', latest: '0.16.0' })
    expect(t.fetches()).toBe(1)
  })

  it('says nothing when the published version is the installed one', async () => {
    const t = setup('0.15.0', ['0.15.0'])
    t.check.available()
    await t.check.check()
    expect(t.check.available()).toBeNull()
  })

  it('looks again only after six hours', async () => {
    const t = setup('0.15.0', ['0.15.0', '0.16.0'])
    t.check.available()
    await t.check.check()
    t.advance(CHECK_EVERY_MS - 1)
    expect(t.check.available()).toBeNull()
    expect(t.fetches()).toBe(1)
    t.advance(1)
    t.check.available()
    await t.check.check()
    expect(t.fetches()).toBe(2)
    expect(t.check.available()).toMatchObject({ latest: '0.16.0' })
  })

  it('tries again sooner after a check that failed, and keeps what it knew', async () => {
    const t = setup('0.15.0', ['0.16.0', new Error('offline')])
    t.check.available()
    await t.check.check()
    t.advance(CHECK_EVERY_MS)
    t.check.available()
    await t.check.check()
    expect(t.check.available()).toMatchObject({ latest: '0.16.0' })
    t.advance(RETRY_AFTER_MS)
    t.check.available()
    expect(t.fetches()).toBe(3)
  })

  it('never checks when the installed version is unknown', () => {
    const t = setup(null, ['0.16.0'])
    expect(t.check.available()).toBeNull()
    expect(t.fetches()).toBe(0)
  })
})

describe('installedVersion', () => {
  function plugin(root: string) {
    const dir = join(root, 'plugins', 'quarterdeck-goals')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    mkdirSync(join(dir, 'server'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.15.0' }))
    return join(dir, 'server')
  }

  it("reads the installed plugin's version from beside the bundled server", () => {
    const server = plugin(mkdtempSync(join(tmpdir(), 'qd-update-')))
    expect(installedVersion(server, {})).toBe('0.15.0')
  })

  it('is off in a checkout and when turned off', () => {
    const root = mkdtempSync(join(tmpdir(), 'qd-update-'))
    const server = plugin(root)
    expect(installedVersion(server, { QUARTERDECK_UPDATE_CHECK: '0' })).toBeNull()
    mkdirSync(join(root, 'mcp', 'src'), { recursive: true })
    expect(installedVersion(server, {})).toBeNull()
  })
})

describe('goals_overview with an update', () => {
  const update = { installed: '0.15.0', latest: '0.16.0' }

  it('carries the update, and its etag changes when one appears', () => {
    const body = JSON.stringify({ goals: [] })
    const plain = overviewAnswer(undefined, body, '"abc"', null)
    expect(plain).toEqual({ changed: true, etag: '"abc"', goals: [] })
    const withUpdate = overviewAnswer(plain.etag, body, '"abc"', update)
    expect(withUpdate).toMatchObject({ changed: true, update, goals: [] })
    expect(overviewAnswer(withUpdate.etag, body, '"abc"', update)).toEqual({ changed: false, etag: withUpdate.etag })
  })

  it('reports none from a checkout (where these tests run)', async () => {
    expect(await goals_overview({})).not.toHaveProperty('update')
  })
})
