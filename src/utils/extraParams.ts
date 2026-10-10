/**
 * 「额外参数 / 环境变量」与 preset 键值对之间的转换。
 *
 * preset 文件只接受 `key = value` 形式，没有"原始命令行片段"的概念。因此：
 * - **额外参数**：以命令行片段编辑（如 `--jinja --chat-template-file "D:\x.jinja"`），
 *   保存时按 `--flag [value]` 解析成键值对写入 preset；读取时把 preset 中不在参数 schema
 *   里的键重新拼回片段，双向一致。
 * - **环境变量**：llama.cpp 的 preset 支持以环境变量名作为键（官方 README 示例
 *   `LLAMA_ARG_CACHE_RAM = 0`），所以 `LLAMA_ARG_*` 直接写进 preset 即可生效。
 */

/**
 * 把命令行片段切成 token（支持单/双引号包裹的值）。
 *
 * 双引号里认 `\` 转义（`\\.` 一起消费），因为 `quoteIfNeeded` 写出来的引号是
 * **带转义**的：含 `"` 或 `\` 的值会被写成 `"a\"b"` / `"a\\b"`。
 * 早先这里用 `/"([^"]*)"|'([^']*)'|(\S+)/g` —— 不认转义，于是
 * `--chat-template-file "D:\x\"y.jinja"` 会被拆成多个 token，写回再读就变了样。
 * 单引号分支保持原样（不用单引号包裹任何值，也就不会产生单引号内的转义）。
 */
/**
 * 一个命令行 token 是不是 flag（而不是某个 flag 的取值）。
 *
 * 判据是「以 `-` 开头**且不是数字**」。只看首字符会把负数取值误判成 flag：
 * `--n-gpu-layers -1`、`--main-gpu -1`、`--temp -1` 都是合法写法
 * （-1 表示「全部层」/「默认卡」），误判后 `-1` 会变成没有归属的孤立 token 被丢掉，
 * 只剩一个裸 `--n-gpu-layers`（`n-gpu-layers = true`，router 直接报错）。
 *
 * `utils/strataParams.ts` 的 args 解析必须复用这一个实现：判据分家就会一边把上游写的
 * 未知开关（`--native`）当成取值吞掉、另一边把负数取值当成开关丢掉。
 */
export function isFlagToken(token: string): boolean {
  return token.startsWith("-") && Number.isNaN(Number(token));
}

export function tokenizeCommandLine(text: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // 双引号分支要把转义还原，否则 `\"` 会带着反斜杠进入 preset
    tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? match[3]));
  }
  return tokens;
}

/** 命令行片段 → preset 键值对。`--flag` 单独出现时记为 `true`。 */
export function parseExtraParams(text: string): [string, string][] {
  const tokens = tokenizeCommandLine(text);
  const out: [string, string][] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("-")) continue; // 裸值（没有对应 flag）忽略
    const key = token.replace(/^-+/, "");
    if (!key) continue;

    const next = tokens[i + 1];
    if (next !== undefined && !isFlagToken(next)) {
      out.push([key, next]);
      i += 1;
    } else {
      out.push([key, "true"]);
    }
  }
  return out;
}

/**
 * 值需要引号包裹时就包起来，并转义 `\` 与 `"`。
 *
 * 判据里带上 `"` 与 `'`：含引号的值不加引号会被 `tokenizeCommandLine` 的
 * 引号分支从中间截断。转义规则与 `tokenizeCommandLine` 的 `\\.` 分支互为逆运算
 * （两个函数必须一起改）。
 */
function quoteIfNeeded(value: string): string {
  if (!/[\s"']/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * preset 键值对 → 命令行片段（用于在界面上继续编辑）。
 *
 * **只有 `true` 与空串才写成裸 flag**：值为字面 `1` 的参数（`--threads 1`、
 * `--batch-size 1`、`--n-gpu-layers 1`）如果也写成裸 `--threads`，`parseExtraParams`
 * 读回来就是 `"true"` —— 弹窗开一次、保存一次，`threads = 1` 就变成了
 * `threads = true`，语义被悄悄改掉（用户看到的输入框内容还「一样」）。
 */
export function formatExtraParams(entries: [string, string][]): string {
  return entries
    .map(([key, value]) =>
      value === "" || value === "true" ? `--${key}` : `--${key} ${quoteIfNeeded(value)}`,
    )
    .join(" ");
}

/** 是否属于「环境变量」类的键（只有 LLAMA_ARG_ 前缀会被 llama.cpp 当作环境变量）。 */
export function isEnvKey(key: string): boolean {
  return /^LLAMA_ARG_/i.test(key);
}

/** 校验环境变量键名；返回错误信息或 null。 */
export function validateEnvKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return null; // 空行忽略
  if (!isEnvKey(trimmed)) {
    return "只有 LLAMA_ARG_ 开头的键会被 llama.cpp 当作环境变量；其他键请用「额外参数」";
  }
  if (!/^[A-Za-z0-9_]+$/.test(trimmed)) {
    return "环境变量名只能包含字母、数字与下划线";
  }
  return null;
}
