/**
 * 列表页的纯逻辑：preset 段解析、扫描结果与 router 运行态的合并、过滤排序。
 *
 * 从 ModelListPanel 里抽出来放在这里，一是让 App 头部也能算同一份计数，
 * 二是避免组件文件同时导出组件与非组件（会破坏 Fast Refresh）。
 */

import { portFromArgs } from "../api/router";
import type { ModelView, RouterModel, ScannedModel } from "../types";

/** 从 preset 文本中解析段名。 */
export function presetSections(text: string): Set<string> {
  const set = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (m && m[1] !== "*") set.add(m[1].trim());
  }
  return set;
}

/**
 * 净化 preset 段名：去掉**结构字符**，并 trim 首尾空白。
 *
 * 依据是 llama.cpp `common/preset.cpp` 的 PEG 语法（master 分支）：
 *
 * ```
 * header-line ::= "[" ws (section-name = [^]]*) ws "]" eol
 * ```
 *
 * 段名是 `[^]]*` —— 遇到第一个 `]` 就结束，所以段名里的 `]` 会让
 * `[a]b]` 这种段头被解析成段名 `a` 加一段垃圾，**后续所有行的归属都错位**；
 * 换行则直接终止 header-line（`eol ::= ws comment? (newline / EOF)`），
 * 一个输入凭空造出两行、第二行成为无法解析的内容。两者都会让后端解析出的段名
 * 与预期不符，失败时正好走「删旧段」的路径，把用户原本能用的配置一起弄丢。
 * `[` 一并去掉：它在段名里虽然合法，但再写一遍就会拼出嵌套的段头。
 *
 * 刻意**只**过滤这四类字符 + trim：router 侧段名有 `名字:tag` 的规范化
 * （正则 `[-.](([A-Z0-9_]+))$`，icase，tag 转大写），`:`、`_`、`-`、`.`、空格
 * 都是合法组成部分，做「只允许字母数字」那种限制会把它们误伤掉。
 */
export function sanitizeSectionName(name: string): string {
  return name.replace(/[[\]\r\n]/g, "").trim();
}

/** 取某个段里某个键的值（没有该键返回 null）。 */
export function presetValue(text: string, section: string, key: string): string | null {
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inside = header[1].trim() === section;
      continue;
    }
    if (!inside) continue;
    const kv = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1].toLowerCase() === key.toLowerCase()) return kv[2].trim();
  }
  return null;
}

/**
 * 该模型的段落是否关掉了自带 WebUI。
 *
 * 两种写法都认（实测两者都会让子实例带上 `--no-webui`）：
 * - `no-webui = 1`（hub 参数表与界面用的键名，也是我们表单写入的形式）
 * - `webui = 0`（llama.cpp 自己渲染 preset 时用的形式）
 *
 * router 模式下用 router 自己的界面就够了，子实例可以不带界面；
 * 关掉后模型卡片上的「聊天」入口要禁用，否则打开的是 404 页面。
 */
export function webuiDisabled(text: string, section: string): boolean {
  const noWebui = presetValue(text, section, "no-webui");
  if (noWebui != null && truthyValue(noWebui)) return true;
  const webui = presetValue(text, section, "webui");
  if (webui != null && !truthyValue(webui)) return true;
  return false;
}

/** preset 里「算作真」的取值（llama.cpp 的 bool 解析：0/false/no/off 与空串为假）。 */
function truthyValue(v: string): boolean {
  return !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

/**
 * 一次扫完整份 preset，得到「关掉了自带 WebUI 的段名」集合。
 *
 * 存在的理由：模型列表的每张卡片原来各自调 `webuiDisabled(presetText, section)`，
 * 于是每张卡在每次渲染时都要把整份 presets.ini `split(/\r?\n/)` 扫一遍 ——
 * 卡片数与文件行数相乘。这里把全文只解析一次，调用方（父组件 useMemo）算成
 * 集合再往下传，单卡的开销降成一次 `Set.has`。
 *
 * 取值语义与 `webuiDisabled` 严格一致：段内同名键取**第一次**出现的值
 * （`presetValue` 命中即返回），`no-webui` 为真或 `webui` 为假都算关闭。
 */
export function webuiDisabledSections(text: string): Set<string> {
  /** 段名 → 该段里 `no-webui` / `webui` 首次出现的原始值 */
  const keys = new Map<string, { noWebui?: string; webui?: string }>();
  let section: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section == null) continue;
    const kv = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const name = kv[1].toLowerCase();
    if (name !== "no-webui" && name !== "webui") continue;
    const entry = keys.get(section) ?? {};
    if (name === "no-webui") {
      if (entry.noWebui === undefined) entry.noWebui = kv[2].trim();
    } else if (entry.webui === undefined) {
      entry.webui = kv[2].trim();
    }
    keys.set(section, entry);
  }

  const out = new Set<string>();
  for (const [name, entry] of keys) {
    if (entry.noWebui !== undefined && truthyValue(entry.noWebui)) out.add(name);
    else if (entry.webui !== undefined && !truthyValue(entry.webui)) out.add(name);
  }
  return out;
}

/**
 * 从 router 的段文本里取 `model = <路径>`（用于把 router 的模型对回扫描结果：
 * 段名可以被用户改（别名），但 `model` 指的还是那个 gguf）。
 */
function presetModelPath(section: string | undefined): string | null {
  if (!section) return null;
  for (const line of section.split(/\r?\n/)) {
    const m = /^\s*model\s*=\s*(.+)$/i.exec(line);
    if (m) return m[1].trim().replace(/\\/g, "/").toLowerCase();
  }
  return null;
}

/**
 * 合并「扫描结果」与「router 状态」。
 *
 * `aliases`（settings 里存）记录"扫描出来的模型 → preset 段名"：用户在配置里改了别名后，
 * 段名会跟着改，router 里的模型名也随之变化（router 给子实例下发 `--alias <段名>`）。
 * 因此 router 报回来的名字可能既不是目录名也不是扫描 id，需要按三种线索对回去：
 * 别名表 → 同名 id → 段文本里的 `model = <路径>`。
 *
 * 对上的那一条以 router 的段名为准（`section`），启动/停止/聊天都用它。
 */
export function mergeModels(
  scanned: ScannedModel[],
  routerModels: RouterModel[],
  favourites: string[],
  sections: Set<string>,
  aliases: Record<string, string> = {},
): ModelView[] {
  const byId = new Map<string, ModelView>();
  /** 段名 → 扫描 id */
  const aliasToId = new Map<string, string>();
  /** 归一化后的 gguf 路径 → 扫描 id */
  const pathToId = new Map<string, string>();
  for (const [id, alias] of Object.entries(aliases)) {
    if (alias.trim()) aliasToId.set(alias.trim(), id);
  }

  for (const s of scanned) {
    // aliases 里存的是完整段名（含作者前缀），卡片只显示名字部分
    const alias = aliases[s.id]?.trim() ?? "";
    const section = alias || s.id;
    const displayName = alias ? (alias.split("/").pop() || alias) : s.name;
    pathToId.set(s.path.replace(/\\/g, "/").toLowerCase(), s.id);
    byId.set(s.id, {
      id: s.id,
      section,
      name: displayName,
      quantization: s.quantization,
      sizeBytes: s.size_bytes,
      shards: s.shards,
      hasMmproj: Boolean(s.mmproj),
      group: s.group,
      status: "unloaded",
      port: null,
      loadProgress: null,
      loadingStage: null,
      source: "preset",
      failed: false,
      exitCode: null,
      favourite: favourites.includes(s.id),
      inPreset: sections.has(section),
      scanned: s,
    });
  }

  for (const r of routerModels) {
    const status = r.status?.value ?? "unloaded";
    // 段名可能被改过：按 别名表 → 同名 id → 段里的 model 路径 依次对回扫描结果
    const matchedId =
      aliasToId.get(r.id) ??
      (byId.has(r.id) ? r.id : undefined) ??
      (() => {
        const path = presetModelPath(r.status?.preset);
        return path ? pathToId.get(path) : undefined;
      })();
    const existing = matchedId ? byId.get(matchedId) : undefined;
    const key = matchedId ?? r.id;
    const base: ModelView =
      existing ??
      ({
        id: r.id,
        section: r.id,
        name: r.id,
        quantization: null,
        sizeBytes: null,
        shards: 1,
        hasMmproj: false,
        group: "router",
        status,
        port: null,
        loadProgress: null,
        loadingStage: null,
        source: r.source ?? "preset",
        failed: false,
        exitCode: null,
        favourite: favourites.includes(r.id),
        inPreset: true,
        scanned: null,
      } satisfies ModelView);

    // 显示名：段名被改过时取它的名字部分（作者前缀不上卡片）；
    // 段名与扫描 id 相同则用目录名；router 独有的模型只能用它自己的名字。
    const displayName =
      matchedId && r.id !== matchedId
        ? (r.id.split("/").pop() || r.id)
        : matchedId
          ? base.name
          : r.id;

    byId.set(key, {
      ...base,
      // router 报的段名就是该模型当前的正式名字（启动/停止/聊天都要用它）
      section: r.id,
      name: displayName,
      status,
      port: portFromArgs(r.status?.args) ?? (status === "loaded" ? base.port : null),
      loadProgress: r.status?.progress?.value ?? null,
      loadingStage: r.status?.progress?.current ?? null,
      failed: Boolean(r.status?.failed),
      exitCode: r.status?.exit_code ?? null,
      source: r.source ?? base.source,
      inPreset: true,
    });
  }

  return Array.from(byId.values());
}

/**
 * 由「模型名部分」组合出 preset 段名，作者前缀保留。
 *
 * 作者取**扫描 id**（`Ornith-ai/xxx`）而不是当前段名：段名可能已经被改成不带作者的形式
 * （早期版本改别名时就是整段替换），从当前段名取就再也补不回作者了。
 * 输入里自带 `/` 视为整段名，直接采用。
 *
 * 段名会先过 `sanitizeSectionName`：用户在这里输入的文本会以 `[名字]` 写进
 * presets.ini，`]` 与换行能直接破坏 ini 结构（见该函数的注释）。
 */
export function composeSectionName(
  scannedId: string,
  namePart: string,
  currentSection = "",
): string {
  const trimmed = sanitizeSectionName(namePart);
  if (!trimmed) return sanitizeSectionName(scannedId);
  if (trimmed.includes("/")) return trimmed;
  const withOrg = scannedId.includes("/") ? scannedId : currentSection;
  const slash = withOrg.lastIndexOf("/");
  return slash >= 0 ? sanitizeSectionName(`${withOrg.slice(0, slash + 1)}${trimmed}`) : trimmed;
}

/** 显示名：只取段名的最后一段（作者前缀不上卡片）。 */
export function displayNameOfSection(section: string): string {
  return section.split("/").pop() || section;
}

export function fmtSize(bytes: number | null): string {
  if (bytes == null) return "—";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export type ModelFilter = "all" | "loaded" | "favourite" | "missing";
export type ModelSort = "name" | "size";

export interface ListQuery {
  query: string;
  filter: ModelFilter;
  sort: ModelSort;
  desc: boolean;
  /**
   * 置顶项（与名称/大小排序**叠加**，两项之间互斥）：
   * - `active`：「运行中优先」
   * - `favourite`：「收藏优先」
   */
  pinned?: "active" | "favourite";
}

/** 过滤 + 排序。 */
export function selectModels(models: ModelView[], q: ListQuery): ModelView[] {
  const needle = q.query.trim().toLowerCase();
  const list = models.filter((m) => {
    if (needle && !m.id.toLowerCase().includes(needle) && !m.name.toLowerCase().includes(needle)) {
      return false;
    }
    switch (q.filter) {
      case "loaded":
        return m.status === "loaded" || m.status === "loading" || m.status === "sleeping";
      case "favourite":
        return m.favourite;
      case "missing":
        return !m.inPreset;
      default:
        return true;
    }
  });

  return list.sort((a, b) => {
    if (q.pinned === "active") {
      const aActive = a.status !== "unloaded";
      const bActive = b.status !== "unloaded";
      if (aActive !== bActive) return aActive ? -1 : 1;
    } else if (q.pinned === "favourite") {
      if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
    }
    const d =
      q.sort === "size"
        ? (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)
        : a.name.localeCompare(b.name, "zh-Hans-CN");
    return q.desc ? -d : d;
  });
}
