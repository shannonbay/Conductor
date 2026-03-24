// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
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

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('NewPlanButton – localStorage persistence', () => {
  it('initialises Working Directory field from localStorage when a saved value exists', () => {
    localStorage.setItem(LS_KEY, '/saved/path')
    render(<NewPlanButton />)

    // Open the Create Plan dialog
    fireEvent.click(screen.getByRole('button', { name: /\+ New Plan/i }))

    const input = screen.getByPlaceholderText('/path/to/project')
    expect(input).toHaveValue('/saved/path')
  })

  it('Working Directory field is empty when no saved value exists', () => {
    render(<NewPlanButton />)
    fireEvent.click(screen.getByRole('button', { name: /\+ New Plan/i }))

    const input = screen.getByPlaceholderText('/path/to/project')
    expect(input).toHaveValue('')
  })

  it('stores the selected folder in localStorage when "Select this folder" is clicked', async () => {
    mockFetchBrowse()
    render(<NewPlanButton />)
    fireEvent.click(screen.getByRole('button', { name: /\+ New Plan/i }))

    // Click Browse
    fireEvent.click(screen.getByRole('button', { name: /browse/i }))

    // Wait for the browser dialog to appear
    await waitFor(() => screen.getByText('Select Working Directory'))

    // Click "Select this folder"
    fireEvent.click(screen.getByRole('button', { name: /select this folder/i }))

    expect(localStorage.getItem(LS_KEY)).toBe(BROWSE_RESPONSE.path)
  })

  it('populates Working Directory field with the selected folder path after selection', async () => {
    mockFetchBrowse()
    render(<NewPlanButton />)
    fireEvent.click(screen.getByRole('button', { name: /\+ New Plan/i }))

    fireEvent.click(screen.getByRole('button', { name: /browse/i }))
    await waitFor(() => screen.getByText('Select Working Directory'))
    fireEvent.click(screen.getByRole('button', { name: /select this folder/i }))

    const input = screen.getByPlaceholderText('/path/to/project')
    expect(input).toHaveValue(BROWSE_RESPONSE.path)
  })

  it('opens the browse dialog at the saved path when Working Directory is empty', async () => {
    localStorage.setItem(LS_KEY, '/saved/path')
    mockFetchBrowse({ ...BROWSE_RESPONSE, path: '/saved/path', parent: '/', dirs: [] })

    render(<NewPlanButton />)
    fireEvent.click(screen.getByRole('button', { name: /\+ New Plan/i }))

    // Clear the input so workingDir is empty, then click Browse
    const input = screen.getByPlaceholderText('/path/to/project')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /browse/i }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent('/saved/path')),
      )
    })
  })

  it('opens the browse dialog using the current Working Directory when it is non-empty', async () => {
    mockFetchBrowse({ ...BROWSE_RESPONSE, path: '/explicit/path', parent: '/', dirs: [] })

    render(<NewPlanButton />)
    fireEvent.click(screen.getByRole('button', { name: /\+ New Plan/i }))

    const input = screen.getByPlaceholderText('/path/to/project')
    fireEvent.change(input, { target: { value: '/explicit/path' } })
    fireEvent.click(screen.getByRole('button', { name: /browse/i }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent('/explicit/path')),
      )
    })
  })
})
