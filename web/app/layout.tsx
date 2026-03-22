import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Conductor',
  description: 'Visual task tree management for AI agents',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">{children}</body>
    </html>
  )
}
