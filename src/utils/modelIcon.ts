/**
 * 架构 → 品牌图标，与 llama.cpp-hub 的 `getModelIcon()` 保持同一张映射表。
 *
 * 图标文件取自本机 llama.cpp-hub 的 `web/icon/`（同一批 PNG），仅用于型号识别。
 * 这里用 Vite 的 `import.meta.glob` 收集，打包后是带 hash 的资源 URL，
 * 不依赖运行时的绝对路径（Tauri 生产环境不是 http 服务）。
 */

const FILES = import.meta.glob("../assets/icons/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** 文件名（不含扩展名）→ 打包后的 URL */
const BY_NAME: Record<string, string> = {};
for (const [path, url] of Object.entries(FILES)) {
  const name = path.split("/").pop()?.replace(/\.png$/i, "") ?? "";
  if (name) BY_NAME[name] = url;
}

/** 与 hub 完全一致的匹配表（顺序即优先级） */
const ICON_MAP: [string, string][] = [
  ["qwen", "qwen"],
  ["glm", "glm"],
  ["hunyuan", "hunyuan"],
  ["hy", "hunyuan"],
  ["mistral", "mistral3"],
  ["gpt", "openai"],
  ["seed", "seed_oss"],
  ["llama", "llama"],
  ["muse", "llama"],
  ["kimi", "kimi"],
  ["minimax", "minimax"],
  ["gemma", "gemma"],
  ["deepseek", "deepseek"],
  ["deepseek2", "deepseek"],
  ["deepseek3", "deepseek"],
  ["step", "step35"],
  ["paddleocr", "paddleocr"],
  ["bailingmoe", "bailingmoe"],
  ["lfm", "lfm"],
  ["lfm2", "lfm"],
  ["nemotron", "nemotron"],
  ["bert", "bert"],
  ["mimo", "mimo"],
];

/** 应用 logo（侧栏） */
export const appLogo = BY_NAME["app-logo"] ?? "";

/**
 * 取模型图标。
 *
 * hub 只按 GGUF 里的 `general.architecture` 匹配；我们的扫描结果没有这一项，
 * 因此把模型名与 id 也一并作为匹配源（`Qwen3.5-9B` 这类命名同样能命中），
 * 匹配不到就返回 null —— 与 hub 一样不占位。
 */
export function getModelIcon(...hints: (string | null | undefined)[]): string | null {
  for (const hint of hints) {
    const key = (hint ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!key) continue;
    for (const [needle, file] of ICON_MAP) {
      if (key.includes(needle) && BY_NAME[file]) return BY_NAME[file];
    }
  }
  return null;
}
