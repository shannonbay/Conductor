import { NextRequest } from 'next/server'
import { readdirSync, statSync } from 'fs'
import { join, resolve, dirname } from 'path'
import os from 'os'

export function GET(req: NextRequest) {
  const rawPath = req.nextUrl.searchParams.get('path') || os.homedir()
  const dirPath = resolve(rawPath)

  try {
    statSync(dirPath)
  } catch {
    return Response.json({ error: 'Path not found' }, { status: 400 })
  }

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const parent = dirname(dirPath)

    return Response.json({
      path: dirPath,
      parent: parent !== dirPath ? parent : null,
      dirs,
    })
  } catch {
    return Response.json({ error: 'Cannot read directory' }, { status: 403 })
  }
}
