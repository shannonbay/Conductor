/**
 * The quarterdeck MCP server's tool names. This plugin provides the server
 * (.mcp.json), and Claude Code names a plugin server's tools
 * `mcp__plugin_<plugin>_<server>__<tool>`. Older installs added it by hand
 * (`claude mcp add`), named `mcp__quarterdeck__<tool>`. Both work everywhere.
 * (quarterdeck-guard keeps its own copy: plugins can't share code.)
 */
export const SERVER_PREFIXES = ['mcp__plugin_quarterdeck-goals_quarterdeck__', 'mcp__quarterdeck__'] as const

/** A server tool's full names under both prefixes. */
export function serverToolNames(...tools: string[]): string[] {
  return tools.flatMap((t) => SERVER_PREFIXES.map((p) => p + t))
}
