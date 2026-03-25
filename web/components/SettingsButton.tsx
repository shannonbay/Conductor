'use client'

import { useEffect, useState, useCallback } from 'react'

interface ChannelStatus {
  connected: boolean
  busy: boolean
}

interface SettingsState {
  brave_search_api_key_set: boolean
  brave_search_api_key_prefix: string | null
}

export function SettingsButton() {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [channelStatus, setChannelStatus] = useState<ChannelStatus | null>(null)
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

  const pollChannelStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/channel-status')
      if (res.ok) setChannelStatus(await res.json())
    } catch {
      setChannelStatus({ connected: false, busy: false })
    }
  }, [])

  useEffect(() => {
    // Poll channel status every 5 seconds
    pollChannelStatus()
    const interval = setInterval(pollChannelStatus, 5_000)
    return () => clearInterval(interval)
  }, [pollChannelStatus])

  useEffect(() => {
    if (open) {
      loadSettings()
      setBraveKey('')
      setSaved(false)
      setError(null)
    }
  }, [open])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!braveKey.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brave_search_api_key: braveKey.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save')
      setSaved(true)
      setBraveKey('')
      await loadSettings()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setSaving(false)
    }
  }

  const connected = channelStatus?.connected ?? false
  const busy = channelStatus?.busy ?? false

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Settings"
        className="text-gray-400 hover:text-gray-700 text-base px-2 py-1 flex items-center gap-1.5"
      >
        <span
          className={`inline-block w-2 h-2 rounded-full ${connected ? (busy ? 'bg-yellow-400' : 'bg-green-500') : 'bg-red-400'}`}
          title={connected ? (busy ? 'Claude Code busy' : 'Claude Code connected') : 'Claude Code not connected'}
        />
        ⚙
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Settings</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700">✕</button>
            </div>

            {/* Channel status */}
            <div className="mb-4 p-3 rounded-lg bg-gray-50 border border-gray-200">
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${connected ? (busy ? 'bg-yellow-400' : 'bg-green-500') : 'bg-red-400'}`} />
                <span className="text-sm font-medium text-gray-700">
                  {connected
                    ? busy ? 'Claude Code — busy' : 'Claude Code — connected'
                    : 'Claude Code — not connected'}
                </span>
              </div>
              {!connected && (
                <p className="text-xs text-gray-500 mt-1.5 font-mono">
                  claude --dangerously-load-development-channels server:conductor-channel
                </p>
              )}
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Brave Search API Key <span className="text-gray-400 font-normal">(for web_search)</span>
                </label>
                {settings && (
                  <p className="text-xs text-gray-500 mb-2">
                    {settings.brave_search_api_key_set
                      ? <>Set: <span className="font-mono">{settings.brave_search_api_key_prefix}</span></>
                      : 'Not configured'}
                  </p>
                )}
                <input
                  type="password"
                  value={braveKey}
                  onChange={(e) => setBraveKey(e.target.value)}
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
                  disabled={!braveKey.trim() || saving}
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
