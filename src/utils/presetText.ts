/**
 * preset（INI）文本的读取工具。
 *
 * 独立于组件文件：React Fast Refresh 要求一个模块要么只导出组件、要么不导出组件，
 * 混在一起会让热更新退化成整页刷新。
 */

/** 从 preset 文本中取出某段的键值对。 */
export function sectionEntries(text: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inside = header[1].trim() === section;
      continue;
    }
    if (!inside) continue;
    const kv = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** 取出某段的原始文本（含段头）。 */
export function sectionText(text: string, section: string): string {
  const lines = text.split(/\r?\n/);
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^\\s*\\[${escaped}\\]\\s*$`).test(l));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/** 把 `KEY=VALUE KEY2=VALUE2` 文本解析成 preset 键值对（值可用引号包裹）。 */
export function parseEnvVars(text: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|\S*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push([m[1], m[3] ?? m[4] ?? m[2]]);
  }
  return out;
}
