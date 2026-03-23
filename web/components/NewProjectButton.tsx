'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  size?: 'default' | 'lg'
}

export function NewProjectButton({ size = 'default' }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, working_dir: workingDir || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create project')
      router.push(`/projects/${data.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
      setLoading(false)
    }
  }

  const sizeClass = size === 'lg'
    ? 'px-6 py-3 text-base'
    : 'px-4 py-2 text-sm'

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-700 transition-colors ${sizeClass}`}
      >
        + New Project
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-semibold mb-4">Create Project</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="What do you want to work on?"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description <span className="text-gray-400">(optional)</span></label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Working Directory</label>
                <div className="flex gap-2">
                  <input
                    value={workingDir}
                    onChange={(e) => setWorkingDir(e.target.value)}
                    placeholder="/path/to/project"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const input = document.createElement('input')
                      input.type = 'file'
                      input.setAttribute('webkitdirectory', '')
                      input.onchange = () => {
                        const file = input.files?.[0]
                        if (file?.webkitRelativePath) {
                          const topDir = file.webkitRelativePath.split('/')[0]
                          setWorkingDir(topDir)
                        }
                      }
                      input.click()
                    }}
                    className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Browse
                  </button>
                </div>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setOpen(false); setName(''); setDescription(''); setWorkingDir(''); setError(null) }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || !workingDir.trim() || loading}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Creating…' : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
