'use client'

import { useEffect, useState } from 'react'

interface SettingsState {
  anthropic_api_key_set: boolean
  anthropic_api_key_prefix: string | null
  anthropic_auth_token_set: boolean
  anthropic_auth_token_prefix: string | null
  brave_search_api_key_set: boolean
  brave_search_api_key_prefix: string | null
}

export function SettingsButton() {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [braveKey, setBraveKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings')
      if (res.ok) setSettings(await res.json())
    } catch {}
  }

  useEffect(() => {
    if (open) {
      loadSettings()
      setApiKey('')
      setAuthToken('')
      setBraveKey('')
      setSaved(false)
      setError(null)
    }
  }, [open])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!apiKey.trim() && !authToken.trim() && !braveKey.trim()) return
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, string> = {}
      if (apiKey.trim()) body.anthropic_api_key = apiKey.trim()
      if (authToken.trim()) body.anthropic_auth_token = authToken.trim()
      if (braveKey.trim()) body.brave_search_api_key = braveKey.trim()
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save')
      setSaved(true)
      setApiKey('')
      setAuthToken('')
      setBraveKey('')
      await loadSettings()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Settings"
        className="text-gray-400 hover:text-gray-700 text-base px-2 py-1"
      >
        ⚙
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Settings</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700">✕</button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                {settings && (
                  <p className="text-xs text-gray-500 mb-2">
                    {settings.anthropic_api_key_set
                      ? <>Set: <span className="font-mono">{settings.anthropic_api_key_prefix}</span></>
                      : 'Not configured'}
                  </p>
                )}
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-ant-api…"
                  autoFocus
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Auth Token <span className="text-gray-400 font-normal">(Max Plan)</span>
                </label>
                {settings && (
                  <p className="text-xs text-gray-500 mb-2">
                    {settings.anthropic_auth_token_set
                      ? <>Set: <span className="font-mono">{settings.anthropic_auth_token_prefix}</span></>
                      : 'Not configured'}
                  </p>
                )}
                <input
                  type="password"
                  value={authToken}
                  onChange={e => setAuthToken(e.target.value)}
                  placeholder="auth token…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
                <p className="text-xs text-gray-400 mt-1">Auth token takes priority over API key. Saved to ~/.conductor/config.json</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Brave Search API Key <span className="text-gray-400 font-normal">(for web_search tool)</span>
                </label>
                {settings && (
                  <p className="text-xs text-gray-500 mb-2">
                    {settings.brave_search_api_key_set
                      ? <>Set: <span className="font-mono">{settings.brave_search_api_key_prefix}</span></>
                      : 'Not configured — agents cannot use web_search without this'}
                  </p>
                )}
                <input
                  type="password"
                  value={braveKey}
                  onChange={e => setBraveKey(e.target.value)}
                  placeholder="BSA…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
              {saved && <p className="text-sm text-green-600">Saved.</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={(!apiKey.trim() && !authToken.trim() && !braveKey.trim()) || saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
