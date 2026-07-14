import type { ChatTool } from '../types';

/** A monochrome category glyph per tool kind — keeps the list scannable
 *  without pulling in an icon font or inconsistent color emoji. */
function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith('mcp__')) return '⬡';
  if (/edit|write|notebook/.test(n)) return '✎';
  if (n.includes('read')) return '▤';
  if (n.includes('bash') || n.includes('powershell')) return '$';
  if (n.includes('grep') || n.includes('glob')) return '⌕';
  if (n.includes('task') || n.includes('agent')) return '✳';
  if (n.includes('todo')) return '☑';
  if (n.includes('web') || n.includes('fetch')) return '↗';
  return '▸';
}

/** `mcp__server__tool` → `server · tool`; everything else unchanged. */
function prettyName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** One tool call, rendered as a clean row: category glyph, name, and the
 *  specific detail (filename / command / pattern) in a muted monospace tail. */
export function ToolRow({ tool }: { tool: ChatTool }) {
  return (
    <div className="tool-row" title={tool.detail || tool.name}>
      <span className="tool-row__icon">{toolIcon(tool.name)}</span>
      <span className="tool-row__name">{prettyName(tool.name)}</span>
      {tool.detail && <span className="tool-row__detail">{tool.detail}</span>}
    </div>
  );
}
