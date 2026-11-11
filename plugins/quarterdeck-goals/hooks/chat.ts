/**
 * Bringing something into the conversation: sent as a prompt at once, unless
 * the person has started typing one; then it's added to their draft, so they
 * can say what they want to ask about it.
 */
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

export async function sendToChat($: Engine, prompt: string, aside: string): Promise<'sent' | 'added'> {
  const { text: draft } = await $.prompt.read()
  if (draft.trim()) {
    const filled = await $.prompt.fill({ text: ` (${aside})`, mode: 'append' })
    if (filled.isFilled) {
      $.ui.toast('Added to your prompt: press Enter to send it.')
      return 'added'
    }
  }
  await $.prompt.submit({ text: prompt })
  return 'sent'
}
