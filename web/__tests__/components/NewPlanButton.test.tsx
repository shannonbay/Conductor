// @vitest-environment jsdom

// Tell React to enable act() checking in this jsdom environment
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { NewPlanButton } from '@/components/NewPlanButton'

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const LS_KEY = 'conductor:lastBrowseDir'

const BROWSE_RESPONSE = {
  path: '/home/user/projects',
  parent: '/home/user',
  dirs: [
    { name: 'my-app', path: '/home/user/projects/my-app' },
    { name: 'other', path: '/home/user/projects/other' },
  ],
}

function mockFetchBrowse(data = BROWSE_RESPONSE) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => data,
  } as Response)
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function renderComponent() {
  act(() => {
    root.render(<NewPlanButton />)
  })
}

function openDialog() {
  const btn = container.querySelector('button') as HTMLButtonElement
  act(() => { btn.click() })
}

function getWorkingDirInput(): HTMLInputElement {
  return container.querySelector('input[placeholder="/path/to/project"]') as HTMLInputElement
}

function clickButton(name: string): void {
  const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
  const btn = buttons.find(b => b.textContent?.trim() === name)
  if (!btn) throw new Error(`Button "${name}" not found`)
  act(() => { btn.click() })
}

describe('NewPlanButton – localStorage persistence', () => {
  it('initialises Working Directory field from localStorage when a saved value exists', () => {
    localStorage.setItem(LS_KEY, '/saved/path')
    renderComponent()
    openDialog()

    const input = getWorkingDirInput()
    expect(input).not.toBeNull()
    expect(input.value).toBe('/saved/path')
  })

  it('Working Directory field is empty when no saved value exists', () => {
    renderComponent()
    openDialog()

    const input = getWorkingDirInput()
    expect(input).not.toBeNull()
    expect(input.value).toBe('')
  })

  it('stores the selected folder in localStorage when "Select this folder" is clicked', async () => {
    mockFetchBrowse()
    renderComponent()
    openDialog()

    // Click Browse
    clickButton('Browse')

    // Wait for fetch to resolve and browseDialog to appear
    await act(async () => {
      await Promise.resolve()
    })

    clickButton('Select this folder')

    expect(localStorage.getItem(LS_KEY)).toBe(BROWSE_RESPONSE.path)
  })

  it('populates Working Directory field with the selected folder path after selection', async () => {
    mockFetchBrowse()
    renderComponent()
    openDialog()

    clickButton('Browse')

    await act(async () => {
      await Promise.resolve()
    })

    clickButton('Select this folder')

    const input = getWorkingDirInput()
    expect(input.value).toBe(BROWSE_RESPONSE.path)
  })

  it('opens the browse dialog at the saved path when Working Directory is empty', async () => {
    localStorage.setItem(LS_KEY, '/saved/path')
    mockFetchBrowse({ ...BROWSE_RESPONSE, path: '/saved/path', parent: '/', dirs: [] })

    renderComponent()
    openDialog()

    // Clear the input so workingDir is empty
    const input = getWorkingDirInput()
    act(() => {
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const changeEvent = new Event('change', { bubbles: true })
      input.dispatchEvent(changeEvent)
    })

    // Simulate React onChange
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    clickButton('Browse')

    await act(async () => {
      await Promise.resolve()
    })

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('/saved/path')),
    )
  })

  it('opens the browse dialog using the current Working Directory when it is non-empty', async () => {
    mockFetchBrowse({ ...BROWSE_RESPONSE, path: '/explicit/path', parent: '/', dirs: [] })

    renderComponent()
    openDialog()

    // Set the input via React's synthetic event system
    const input = getWorkingDirInput()
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      nativeInputValueSetter?.call(input, '/explicit/path')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    clickButton('Browse')

    await act(async () => {
      await Promise.resolve()
    })

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('/explicit/path')),
    )
  })
})
