const ADJECTIVES = [
  'swift', 'bold', 'calm', 'keen', 'sage', 'bright', 'quiet', 'sharp',
  'brave', 'witty', 'deft', 'proud', 'nimble', 'sly', 'warm', 'cool',
  'fleet', 'wise', 'stark', 'crisp',
]
const NOUNS = [
  'falcon', 'panda', 'otter', 'lynx', 'crane', 'finch', 'raven', 'ibis',
  'gecko', 'stoat', 'vole', 'newt', 'wren', 'mink', 'swift', 'kite',
  'egret', 'dingo', 'capybara', 'quokka',
]

export function generateNickname(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj[0].toUpperCase()}${adj.slice(1)} ${noun[0].toUpperCase()}${noun.slice(1)}`
}
