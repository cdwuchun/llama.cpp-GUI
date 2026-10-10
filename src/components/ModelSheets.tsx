import { useEffect, useMemo, useRef, useState } from "react";

import { ipc } from "../ipc";
import { useApp } from "../store";
import { getFitEntry, putFitEntry, type FitCacheEntry } from "../utils/fitCache";
import type { FitRow, ModelView } from "../types";
import { formatExtraParams, isEnvKey, parseExtraParams } from "../utils/extraParams";
import { getModelIcon } from "../utils/modelIcon";
import { composeSectionName, displayNameOfSection, presetSections, sanitizeSectionName } from "../utils/models";
import { initParamState, paramSchema, paramStateToEntries, type ParamState } from "../utils/paramSchema";
import { parseEnvVars, sectionEntries, sectionText } from "../utils/presetText";
import { ParamForm } from "./ParamForm";
import { Modal } from "./Sheet";

/** 同名键只保留最后一次出现（后者覆盖前者）。 */
function dedupeEntries(entries: [string, string][]): [string, string][] {
  const map = new Map<string, string>();
  for (const [key, value] of entries) {
    if (!key) continue;
    map.set(key, value);
  }
  return [...map.entries()];
}

/**
 * 该模型的 preset 段里，哪些键由本组件专门处理（其余归入「额外参数」）。
 *
 * 只列**不在参数表里**的键：`--device` / `--main-gpu` 由左栏控件负责，
 * `model` 是模型路径。张量切分没有放进来 —— 它就是参数表里的
 * `--tensor-split`（张量拆分比例），左栏不再重复一份。
 */
const RESERVED_KEYS = new Set(["model", "device", "main-gpu"]);

/**
 * 已经被 llama.cpp 淘汰的 preset 键：**既不显示、也不写回**。
 *
 * 它们留在段里会让整个 router 拒绝启动（不是只有那一段失效）：
 * `failed to initialize router models: option 'no-mmap' not recognized in preset 'X'`。
 * 后端写回 preset 时也会删掉（见 models.rs 的 `RETIRED_PRESET_KEYS`），
 * 这里同步一份是为了不在「额外参数」里把它显示成一个可编辑项 —— 用户改它只会白改。
 */
const RETIRED_KEYS = new Set(["no-mmap"]);

/**
 * 与显存占用**无关**的参数（纯采样、线程、结构化输出等）。
 *
 * 参数指纹要拿它们排除掉：指纹原本直接取全量 entries，于是改个温度、top-p 也会
 * 提示「结果可能要重算」—— 那是噪音。反过来，kv-unified / mmproj / spec-* 这些
 * 虽然 fit-params 不认，却实实在在于影响占用，必须留在指纹里。
 */
const NON_MEMORY_KEYS = new Set([
  "threads",
  "seed",
  "temp",
  "top-p",
  "top-k",
  "min-p",
  "top-nsigma",
  "presence-penalty",
  "repeat-penalty",
  "frequency-penalty",
  "dry-multiplier",
  "dry-base",
  "dry-allowed-length",
  "dry-penalty-last-n",
  "samplers",
  "numa",
  "json-schema",
  "json-schema-file",
]);

/**
 * 配置弹窗两栏的滚动位置记忆（按模型分开记）。
 *
 * 左栏（简要配置）与右栏（详细参数）是各自独立的滚动容器，所以各记一份；
 * 按段名区分是因为不同模型的参数行数不同，滚动范围也不一样。
 */
function scrollKey(section: string, pane: "basic" | "detail"): string {
  return `configScroll:${section}:${pane}`;
}

function loadScrollTop(key: string): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function saveScrollTop(key: string, top: number): void {
  try {
    localStorage.setItem(key, String(Math.max(0, Math.round(top))));
  } catch {
    /* 存不下就算了 */
  }
}

/**
 * 表单快照：用来判断"用户有没有改过"。
 *
 * 只收会影响写盘结果的字段 —— 滚动位置、移动端页签（basic/detail）都刻意不算，
 * 切个页签就被问"有未保存的修改"很烦。
 */
function formSnapshot(v: {
  alias: string;
  mainGpu: string;
  gpuDevices: string[];
  paramState: Record<string, ParamState>;
  extraText: string;
  envText: string;
}): string {
  return JSON.stringify(v);
}

export function ConfigSheet({ model, onClose }: { model: ModelView; onClose: () => void }) {
  const presetText = useApp((s) => s.presetText);
  const busy = useApp((s) => s.busy);
  const devices = useApp((s) => s.devices);
  const status = useApp((s) => s.status);
  const saveModelSection = useApp((s) => s.saveModelSection);
  const removeModelSection = useApp((s) => s.removeModelSection);
  const startModel = useApp((s) => s.startModel);
  const stopModel = useApp((s) => s.stopModel);
  const refreshDevices = useApp((s) => s.refreshDevices);

  // ---- 两栏滚动位置的记忆 ----
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const scrollTimers = useRef<Record<string, number>>({});

  // 打开（或换模型）后恢复上次的滚动位置。等一帧再做：折叠状态与参数行渲染完，
  // scrollHeight 才是最终值，否则设进去的 scrollTop 会被浏览器夹到旧的高度。
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (leftRef.current) {
        leftRef.current.scrollTop = loadScrollTop(scrollKey(model.section, "basic"));
      }
      if (rightRef.current) {
        rightRef.current.scrollTop = loadScrollTop(scrollKey(model.section, "detail"));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [model.section]);

  // 滚动时防抖写入（滚动事件每帧都会来，不必每次都写 localStorage）
  const rememberScroll = (pane: "basic" | "detail") => {
    const el = pane === "basic" ? leftRef.current : rightRef.current;
    if (!el) return;
    const key = scrollKey(model.section, pane);
    const top = el.scrollTop;
    window.clearTimeout(scrollTimers.current[key]);
    scrollTimers.current[key] = window.setTimeout(() => saveScrollTop(key, top), 200);
  };

  useEffect(() => {
    const timers = scrollTimers.current;
    return () => {
      for (const key of Object.keys(timers)) window.clearTimeout(timers[key]);
    };
  }, []);

  const schemaKeys = useMemo(() => new Set(paramSchema.params.map((p) => p.key)), []);

  const [paramState, setParamState] = useState<Record<string, ParamState>>({});
  const [gpuDevices, setGpuDevices] = useState<string[]>([]);
  const [mainGpu, setMainGpu] = useState("-1");
  const [extraText, setExtraText] = useState("");
  const [envText, setEnvText] = useState("");
  const [mobileTab, setMobileTab] = useState<"basic" | "detail">("basic");
  /** 输入框只编辑"模型名"部分；preset 段名里的作者前缀（`作者/`）保持不动 */
  const [alias, setAlias] = useState("");
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  /** 辅助文件表（mmproj / 草稿模型），用来报出「未计入」的那部分占用 */
  const auxFiles = useApp((s) => s.auxFiles);

  // ---- 显存预估（llama-fit-params -fitp on；结果只留最近一次，见 utils/fitCache.ts）----
  const [fitEntry, setFitEntry] = useState<FitCacheEntry | null>(null);
  const [fitBusy, setFitBusy] = useState(false);
  const [fitError, setFitError] = useState("");

  const fitPath = model.scanned?.path ?? "";
  const fitVersion = settings?.selected_version ?? "";
  const fitDevices = devices.map((d) => d.name).join(",");

  useEffect(() => {
    const current = settings?.aliases?.[model.id] ?? model.section;
    setAlias(displayNameOfSection(current));
  }, [settings?.aliases, model.id, model.section]);

  // 只在**切换模型**时用磁盘上的段内容初始化表单。
  //
  // 不能把 `current` 放进依赖：它随 `presetText` 变（保存、刷新、别名变更都会换引用），
  // 那样用户正在编辑的勾选/额外参数/环境变量会被静默重置回磁盘状态
  // （表现就是"我打了一半的字自己变回去了"）。这里用 ref 读最新文本，依赖只有段名。
  const presetTextRef = useRef(presetText);
  presetTextRef.current = presetText;

  /** 打开时的表单快照（见 formSnapshot），关闭前询问就是拿当前值和它比 */
  const initialFormRef = useRef("");

  useEffect(() => {
    const entries = sectionEntries(presetTextRef.current, model.section);
    const nextParams = initParamState(entries);
    const nextDevices = entries["device"]
      ? entries["device"].split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const nextMainGpu = entries["main-gpu"] ?? "-1";
    setParamState(nextParams);
    setGpuDevices(nextDevices);
    setMainGpu(nextMainGpu);

    // preset 中不属于参数 schema、也不属于 GPU 专区的键：
    // LLAMA_ARG_* 还原成环境变量文本，其余还原成命令行片段作为「额外参数」
    const extra: [string, string][] = [];
    const env: string[] = [];
    for (const [key, value] of Object.entries(entries)) {
      // 淘汰键直接丢掉：既不显示，保存时也不会再写回去
      if (schemaKeys.has(key) || RESERVED_KEYS.has(key) || RETIRED_KEYS.has(key)) continue;
      if (isEnvKey(key)) env.push(`${key}=${value}`);
      else extra.push([key, value]);
    }
    const nextExtra = formatExtraParams(extra);
    const nextEnv = env.join(" ");
    setExtraText(nextExtra);
    setEnvText(nextEnv);

    // 这一轮填进去的内容就是「打开时」的样子，作为关闭前询问的基线。
    // 必须在这里同步算出来：写成"首次渲染后记录"记到的是还没填值的空表单，
    // 弹窗一打开就说"有未保存的修改"；换个 effect 记录又要赌执行顺序。
    initialFormRef.current = formSnapshot({
      alias: displayNameOfSection(settings?.aliases?.[model.id] ?? model.section),
      mainGpu: nextMainGpu,
      gpuDevices: nextDevices,
      paramState: nextParams,
      extraText: nextExtra,
      envText: nextEnv,
    });
  }, [model.section, schemaKeys]);

  const envParsed = parseEnvVars(envText);
  const envErrors = envParsed
    .filter(([key]) => !isEnvKey(key))
    .map(([key]) => `环境变量只接受 LLAMA_ARG_ 前缀：${key}`);

  /** 额外参数里会被解析出来的键值对（原样回显，方便核对解析结果） */
  const extraParsed = useMemo(() => parseExtraParams(extraText), [extraText]);

  /**
   * 提交给后端的完整键值对。
   *
   * 注意：**未勾选**的参数会以空值提交，后端把"空值"当作删除该键
   * （preset 是覆盖式机制，不删就永远留着上一次的值）。所以这里不做过滤。
   */
  const entries = useMemo(() => {
    const out: [string, string][] = [];
    if (model.scanned) out.push(["model", model.scanned.path]);
    out.push(...paramStateToEntries(paramState));
    out.push(["device", gpuDevices.join(",")]);
    out.push(["main-gpu", mainGpu === "-1" ? "" : mainGpu]);
    out.push(...extraParsed);
    out.push(...envParsed);
    return dedupeEntries(out);
  }, [model.scanned, paramState, gpuDevices, mainGpu, extraParsed, envParsed]);

  /**
   * 参数指纹。
   *
   * 显存占用跟**右边这一整套参数**强相关（n-gpu-layers / tensor-split / ctx-size /
   * device / 额外参数 / 环境变量……），所以直接拿「提交给后端的这份键值对」当指纹：
   * 用户动过任何一项，指纹就变，界面据此提示「结果可能过时」。
   * 注意**不自动重算** —— 一次要几秒，交给用户点「重新估算」。
   */
  const fitParams = useMemo(
    () => JSON.stringify(entries.filter(([k]) => !NON_MEMORY_KEYS.has(k))),
    [entries],
  );

  // 打开弹窗 / 换模型时取这个模型上次的结果（每个模型各记一份，重启后依然在）
  useEffect(() => {
    setFitEntry(getFitEntry(fitPath));
    setFitError("");
  }, [fitPath]);

  const fitRows: FitRow[] | null = fitEntry?.rows ?? null;
  /** 参数动过了（提示重算，但不自动跑） */
  const fitStale = fitEntry ? fitEntry.params !== fitParams : false;
  /** llama.cpp 版本或设备集合变了（同样只提示） */
  const fitEnvStale = fitEntry
    ? fitEntry.version !== fitVersion || fitEntry.devices !== fitDevices
    : false;
  const fitHint = !fitEntry
    ? ""
    : fitStale
      ? "参数已改动，结果可能要重算（点「重新估算」）。"
      : fitEnvStale
        ? "llama.cpp 版本或设备变了，建议重新估算。"
        : "上次估算 " +
          new Date(fitEntry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) +
          "。";

  /**
   * llama-fit-params 不认 --mmproj / --model-draft（实测直接 invalid argument），
   * 所以多模态投影文件与草稿模型的占用**算不进上面那张表**，这里如实报出来。
   */
  const fitExtras = useMemo(() => {
    const out: string[] = [];
    const mmprojPath = paramState["mmproj"]?.enabled
      ? paramState["mmproj"].value
      : (model.scanned?.mmproj ?? "");
    if (mmprojPath && !paramState["no-mmproj"]?.enabled) {
      const size = auxFiles.find((a) => a.path === mmprojPath)?.size_bytes ?? null;
      out.push("多模态投影" + (size ? "（约 " + Math.round(size / 1024 / 1024) + " MiB）" : ""));
    }
    // 投影文件放哪张卡 / 是否上 GPU 也影响显存，但 fit-params 同样不认
    if (paramState["mmproj-device"]?.enabled || paramState["no-mmproj-offload"]?.enabled) {
      out.push("多模态投影的卸载设置");
    }
    const draftPath = paramState["spec-draft-model"]?.enabled
      ? paramState["spec-draft-model"].value
      : "";
    if (draftPath) {
      const size = auxFiles.find((a) => a.path === draftPath)?.size_bytes ?? null;
      out.push("草稿模型" + (size ? "（约 " + Math.round(size / 1024 / 1024) + " MiB）" : ""));
    }
    if (paramState["spec-draft-ngl"]?.enabled || paramState["spec-draft-device"]?.enabled) {
      out.push("草稿模型的卸载设置");
    }
    // 投机解码：draft-mtp（模型自带 MTP 头）同样要额外加载权重与 KV，但 fit-params 不认
    const specType = paramState["spec-type"]?.enabled
      ? paramState["spec-type"].value
      : paramState["spec-type_ngram-mod"]?.enabled
        ? "ngram-mod"
        : paramState["spec-type_ngram-map-k4v"]?.enabled
          ? "ngram-map-k4v"
          : "";
    if (specType) {
      out.push("投机解码（spec-type = " + specType + "）");
    }
    if (paramState["kv-unified"]?.enabled) {
      out.push("KV 统一（kv-unified）");
    }
    return out;
  }, [paramState, model.scanned?.mmproj, auxFiles]);

  const runFitPreview = async () => {
    if (!fitPath) {
      setFitError("该模型不在扫描结果里，无法定位文件");
      return;
    }
    setFitBusy(true);
    setFitError("");
    try {
      // 把右边这套参数一起送过去：不带它们，算出来的数字跟实际加载对不上
      const rows = await ipc.fitPreview(fitPath, entries);
      const entry: FitCacheEntry = {
        path: fitPath,
        rows,
        at: Date.now(),
        version: fitVersion,
        devices: fitDevices,
        params: fitParams,
      };
      putFitEntry(fitPath, entry);
      setFitEntry(entry);
    } catch (err) {
      // 失败时保留上一次的结果，只把错误显示出来
      setFitError(String(err));
    } finally {
      setFitBusy(false);
    }
  };

  /**
   * 保存配置，返回**保存后的段名**（失败返回 `null`）。
   *
   * 返回值是必须的：改名时旧段会被删掉，调用方若还拿 `model.section` 去启动，
   * `POST /models/load` 会用一个已经不存在的名字，必然失败。
   */
  const save = async (): Promise<string | null> => {
    if (envErrors.length > 0) {
      useApp.getState().setError(envErrors[0]);
      return null;
    }
    // 别名 = 模型名 = preset 段名：router 会给子实例下发 `--alias <段名>`，
    // 所以改段名就等于改 router 里的模型名（`/v1/models`、API 的 model 字段都跟着变）。
    // 段名里的作者前缀保持不动（`Ornith-ai/xxx`）；输入里自带 `/` 时按整段名处理。
    // aliases 里记下"扫描 id → 段名"，下次扫描/合并时才能把 router 报回来的名字对回这个模型。
    const target = composeSectionName(model.id, alias, model.section);
    const renaming = target !== model.section;
    const wasActive = model.status === "loaded" || model.status === "loading";

    // 改段名时若模型正在跑：必须先停掉。实测 router 重载 preset 后旧段名会从模型列表里
    // 消失、新段名显示未加载，而那个子实例仍在运行 —— 变成查不到的孤儿，白占显存。
    if (renaming && wasActive) {
      await stopModel(model.section);
    }

    const sections = new Set(presetSections(useApp.getState().presetText));

    // 先写 preset，成功了再动别的。以前这里不看返回值：写失败时照样往下走，
    // 会删掉旧段、把 aliases 改到一个并不存在的新段名上、甚至去启动一个
    // 根本没写进 preset 的模型 —— 一次失败的保存把用户原本能用的配置也毁了。
    if (!(await saveModelSection(target, entries))) {
      return null;
    }

    const currentAliases = useApp.getState().settings?.aliases ?? {};
    if ((currentAliases[model.id] ?? "") !== (target === model.id ? "" : target)) {
      const next = { ...currentAliases };
      if (target !== model.id) next[model.id] = target;
      else delete next[model.id];
      await saveSettings({ aliases: next });
    }

    // 段改名：旧段名还留着就删掉，否则 router 里会同时出现两个模型
    if (renaming && sections.has(model.section)) {
      await removeModelSection(model.section);
    }

    if (renaming) {
      if (wasActive) {
        useApp.getState().setNotice(`已重命名为「${target}」，正在按新名字重新加载`);
        await startModel(target);
      } else {
        useApp.getState().setNotice(`已重命名为「${target}」，preset 段名同步改掉了`);
      }
    }
    // 已经落盘了，把基线挪到当前表单：否则保存完再点「取消」还要被问一次
    // "有未保存的修改"，其实什么都没丢。
    initialFormRef.current = formSnapshot({
      alias,
      mainGpu,
      gpuDevices,
      paramState,
      extraText,
      envText,
    });
    return target;
  };

  const loaded = model.status === "loaded" || model.status === "loading";

  /** 净化后的段名片段：输入框里保留用户原样输入，落盘与提示文案都用这个值 */
  const cleanedAlias = sanitizeSectionName(alias);

  /**
   * 保存的主 GPU 下标是否已经对不上当前设备列表。
   *
   * 设备一张都没枚举到（length = 0）时不算：那只是还没刷新，不是配置失效，
   * 这时弹警告只会逼着用户去乱改本来正确的配置。
   * 手写进 preset 的非数字值（`main-gpu = cuda0`）也一并标出来 —— llama.cpp 拿到
   * 这种值会直接报错，比"静默套到另一张卡上"好得多。
   */
  const staleMainGpu =
    devices.length > 0 &&
    mainGpu !== "-1" &&
    mainGpu !== "" &&
    (Number.isNaN(Number(mainGpu)) || Number(mainGpu) >= devices.length);

  /**
   * 多模态（视觉）开关。
   *
   * llama.cpp 的行为：模型目录里有 mmproj 时会**自动加载**视觉能力，
   * 想关掉只能显式传 `--no-mmproj`。所以这个开关其实是在
   * 「不写任何键（自动检测 / 按 --mmproj 指定）」与「写 no-mmproj = true」之间切换。
   */
  const detectedMmproj = model.scanned?.mmproj ?? "";
  const visionOff = Boolean(paramState["no-mmproj"]?.enabled);
  const showVisionSwitch =
    Boolean(detectedMmproj) || visionOff || Boolean(paramState["mmproj"]?.enabled);

  const setVision = (on: boolean) => {
    setParamState((s) => ({
      ...s,
      "no-mmproj": { enabled: !on, value: on ? "false" : "true" },
      // 关掉视觉时顺手清掉手填的投影文件，免得下次打开又加载一个用户已经不要的文件
      mmproj: on ? (s["mmproj"] ?? { enabled: false, value: "" }) : { enabled: false, value: "" },
    }));
  };

  const left = (
    <div>
      <div className="form-group">
        <label className="form-label">模型名（同时作为 preset 段名）</label>
        <input
          type="text"
          className="form-control"
          value={alias}
          placeholder={model.name}
          title={`作者前缀取自模型目录，会保留；填整段名（含 /）则按整段用；留空还原为 ${model.id}`}
          onChange={(e) => setAlias(e.target.value)}
        />
        <small className="form-text">
          改这里会同时改掉 preset 段名（= router 里的模型名），作者前缀保留。
        </small>
        {/* 输入框保留用户原样打的字（自己看得出打了什么），真正落盘的是净化后的段名。
            依据：llama.cpp common/preset.cpp 的 PEG 语法里段头是
            `header-line ::= "[" ws (section-name = [^]]*) ws "]" eol` —— 段名遇到第一个
            `]` 就结束，`a]b` 会被解析成段名 `a` 加一段垃圾，后续键的归属全错；
            `eol ::= ws comment? (newline / EOF)` 说明换行直接终止段头行，
            一个输入会凭空造出两行。只过滤 `[ ] \r \n`：`:`、`_`、`-`、`.`、空格
            在段名里合法（router 还会做 `名字:tag` 规范化），不能一并砍掉。 */}
        {alias !== cleanedAlias && (
          <small className="form-text" style={{ color: "var(--warning-color)" }}>
            已忽略 <code>[</code>、<code>]</code> 与换行：preset 的段头是 <code>[名字]</code> 形式，
            段名里出现 <code>]</code> 会让这一段的键归属错乱，换行则会破坏 ini 结构。
            保存时按 <span className="mono">{cleanedAlias || model.id}</span> 写入。
          </small>
        )}
        <small className="form-text mono">{model.scanned?.path ?? model.id}</small>
      </div>

      <div className="form-group">
        <label className="form-label">preset 段名</label>
        <input type="text" className="form-control mono" value={model.section} readOnly disabled />
      </div>

      {showVisionSwitch && (
        <div className="form-group">
          <label className="form-check">
            <input
              type="checkbox"
              className="form-check-input"
              checked={!visionOff}
              onChange={(e) => setVision(e.target.checked)}
            />
            <span className="form-check-label">多模态（视觉）</span>
          </label>
          <small className="form-text">
            {visionOff
              ? "已关闭：不加载视觉能力（写入 --no-mmproj），可以省一点显存"
              : detectedMmproj
                ? `已开启：自动加载同目录的 ${detectedMmproj.split("/").pop()}`
                : "已开启：投影文件留空时由服务器自动检测，也可以在「多模态」分组里指定"}
          </small>
        </div>
      )}

      <div className="form-group" id="mainGpuGroup">
        <label className="form-label">主 GPU</label>
        <select className="form-control" value={mainGpu} onChange={(e) => setMainGpu(e.target.value)}>
          <option value="-1">默认</option>
          {devices.map((d, index) => (
            <option key={d.name} value={String(index)}>
              {d.name}（索引 {index}）
            </option>
          ))}
          {/* 存的索引找不到对应设备时，select 的 value 匹配不上任何 option 会显示成空白 ——
              补一个占位项，让"配置里存的是几号卡"始终可见 */}
          {staleMainGpu && <option value={mainGpu}>索引 {mainGpu}（当前设备列表里没有）</option>}
        </select>
        <small className="form-text">
          选择主 GPU（可选，留默认则由 llama.cpp 决定）。写进 preset 的是**设备下标**：
          llama.cpp 的 <code>--main-gpu</code> 只认数字索引，改存设备名会被 router 拒绝，
          所以这里把设备名和下标一起显示，方便核对打的是哪张卡。
        </small>
        {staleMainGpu && (
          <small className="form-text" style={{ color: "var(--warning-color)" }}>
            配置里保存的下标 {mainGpu} 在本机枚举结果里找不到（当前 {devices.length} 张设备）。
            可能是换了硬件 / 改了驱动，直接启动会让 llama.cpp 拿一个不存在的下标去选设备；
            请重新选一张卡，或改回「默认」。
          </small>
        )}
      </div>

      <div className="form-group">
        <label className="form-label">设备</label>
        <div
          id="deviceChecklist"
          style={{
            border: "1px solid var(--border-color)",
            borderRadius: "0.75rem",
            padding: "0.75rem",
            maxHeight: 260,
            overflow: "auto",
          }}
        >
          {devices.length === 0 ? (
            <div className="settings-empty">
              尚未枚举到设备
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: 8, padding: "0.25rem 0.6rem", fontSize: "0.78rem" }}
                onClick={() => void refreshDevices()}
              >
                <i className="fas fa-sync-alt" /> 重新枚举
              </button>
            </div>
          ) : (
            devices.map((d) => (
              <label
                key={d.name}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "6px 6px",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  style={{ marginTop: 2 }}
                  checked={gpuDevices.includes(d.name)}
                  onChange={() =>
                    setGpuDevices((prev) =>
                      prev.includes(d.name) ? prev.filter((x) => x !== d.name) : [...prev, d.name],
                    )
                  }
                />
                <span style={{ fontSize: "0.9rem" }}>
                  <span className="mono">{d.name}</span>
                  {d.description && <span className="form-text"> {d.description}</span>}
                </span>
              </label>
            ))
          )}
        </div>
        <small className="form-text">
          不勾选 = 使用全部显卡，显存由 <code>--fit</code> 自动分配。
        </small>
      </div>

      <div className="form-group">
        <label className="form-label">显存预估</label>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ padding: "0.35rem 0.8rem", fontSize: "0.82rem" }}
          disabled={fitBusy || !model.scanned}
          title={
            model.scanned
              ? "调 llama-fit-params 算一次：按当前选中的 llama.cpp 版本、全部可见设备"
              : "该模型不在扫描结果里，无法定位文件"
          }
          onClick={() => void runFitPreview()}
        >
          <i className={"fas " + (fitBusy ? "fa-spinner fa-spin" : "fa-calculator")} />
          {fitBusy ? " 计算中…" : fitEntry ? " 重新估算" : " 估算显存"}
        </button>

        {fitError && (
          <small className="form-text" style={{ color: "var(--danger-color)" }}>
            {fitError}
          </small>
        )}

        {fitRows && fitRows.length > 0 ? (
          <div className="fit-table">
            <div className="fit-row is-head">
              <span>设备</span>
              <span>模型</span>
              <span>上下文</span>
              <span>计算</span>
              <span>合计</span>
            </div>
            {fitRows.map((r) => (
              <div className="fit-row" key={r.device}>
                <span className="mono">{r.device}</span>
                <span>{r.model_mib}</span>
                <span>{r.context_mib}</span>
                <span>{r.compute_mib}</span>
                <span className="fit-total">{r.model_mib + r.context_mib + r.compute_mib}</span>
              </div>
            ))}
          </div>
        ) : null}

        {fitRows && fitRows.length > 0 && (
          <small className="form-text">
            {fitHint ? fitHint + " " : ""}
            单位 MiB；合计 = 模型 + 上下文 + 计算。Host 是留在系统内存里的部分。
          </small>
        )}

        {fitRows && fitRows.length > 0 && fitExtras.length > 0 && (
          <small className="form-text" style={{ color: "var(--warning-color)" }}>
            未计入：{fitExtras.join("、")} —— llama-fit-params 不接受这两类参数，
            实际占用还要加上它们。
          </small>
        )}

        {fitRows && fitRows.length === 0 && (
          <small className="form-text">没有解析到结果，请看「系统日志」。</small>
        )}

        {!fitRows && !fitError && !fitBusy && (
          <small className="form-text">
            逐卡预估占用的 MiB（模型 / 上下文 / 计算缓冲）。按全部可见设备计算，不套用上方勾选。
          </small>
        )}
      </div>
    </div>
  );

  const right = (
    <div>
      <ParamForm state={paramState} onChange={setParamState} />

      <div className="form-group" style={{ marginTop: "1rem" }}>
        <label className="form-label">额外参数</label>
        <textarea
          className="form-control"
          rows={2}
          spellCheck={false}
          value={extraText}
          placeholder="例如: --grp-attn-n 8 --grp-attn-w 512"
          onChange={(e) => setExtraText(e.target.value)}
        />
        <small className="form-text">
          输入额外的命令行参数，用空格分隔。不属于上方参数表的键都从这里维护。
        </small>
        {extraParsed.length > 0 && (
          <small className="form-text mono">
            将写入：{extraParsed.map(([k, v]) => `${k}=${v}`).join("  ")}
          </small>
        )}
      </div>

      <div className="form-group" style={{ marginTop: "1rem" }}>
        <label className="form-label">环境变量</label>
        <textarea
          className="form-control mono"
          rows={2}
          spellCheck={false}
          value={envText}
          placeholder={'例如: CUDA_SCALE_LAUNCH_QUEUES=4 MY_VAR="hello world"'}
          onChange={(e) => setEnvText(e.target.value)}
        />
        <small className="form-text">
          格式为 KEY=VALUE，多个用空格分隔，值含空格时用引号包裹；只接受 LLAMA_ARG_ 前缀。
        </small>
        {envErrors.length > 0 ? (
          <small className="form-text" style={{ color: "var(--danger-color)" }}>
            {envErrors[0]}
          </small>
        ) : (
          envParsed.length > 0 && (
            <small className="form-text mono">
              将写入：{envParsed.map(([k, v]) => `${k}=${v}`).join("  ")}
            </small>
          )
        )}
      </div>
    </div>
  );

  // Esc / 点遮罩 / 右上角 × 三条关闭通路都会先问一句：这个表单有几十个参数，
  // 改完误触一下全丢，是这一页最容易踩的坑。用原生 confirm（本仓没有 UI 库，
  // BenchPanel 删记录也用 confirm；Tauri 的 WebView2 里 window.confirm 可用）。
  const confirmClose = () => {
    const current = formSnapshot({ alias, mainGpu, gpuDevices, paramState, extraText, envText });
    if (current === initialFormRef.current) return true;
    return confirm("配置里有未保存的修改，确定关闭吗？");
  };

  return (
    <Modal
      domId="loadModelModal"
      title={loaded ? `配置 · ${model.name}` : `加载模型 · ${model.name}`}
      icon={getModelIcon(model.name, model.id, model.scanned?.dir)}
      onClose={onClose}
      confirmClose={confirmClose}
      bodyClass="load-model-modal"
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-uniform" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-uniform"
            disabled={busy}
            onClick={() => void save()}
          >
            <i className="fas fa-save" /> 保存配置
          </button>
          {loaded ? (
            <button
              type="button"
              className="btn btn-primary btn-uniform"
              disabled={!status.running || busy}
              onClick={() => void stopModel(model.section)}
            >
              <i className="fas fa-stop" /> 停止模型
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-uniform"
              disabled={busy}
              title={model.inPreset ? undefined : "会先保存配置，写入 presets.ini 后再启动"}
              onClick={async () => {
                // 用 save 返回的**新段名**启动：改过名时旧段已经被删掉了，
                // 拿 model.section 去 load 必然失败
                const target = await save();
                if (target) await startModel(target);
              }}
            >
              <i className="fas fa-play" /> 保存并加载
            </button>
          )}
        </>
      }
    >
      <form
        id="loadModelForm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="load-model-layout" data-mobile-tab={mobileTab}>
          <div className="load-model-mobile-tabs">
            <button
              type="button"
              className={`load-model-mobile-tab ${mobileTab === "basic" ? "active" : ""}`}
              onClick={() => setMobileTab("basic")}
            >
              <i className="fas fa-sliders-h" /> 简要配置
            </button>
            <button
              type="button"
              className={`load-model-mobile-tab ${mobileTab === "detail" ? "active" : ""}`}
              onClick={() => setMobileTab("detail")}
            >
              <i className="fas fa-list" /> 详细配置
            </button>
          </div>
          <div id="basicParamsContainer" ref={leftRef} onScroll={() => rememberScroll("basic")}>
            {left}
          </div>
          <div
            className="right-param-area"
            id="dynamicParamsContainer"
            ref={rightRef}
            onScroll={() => rememberScroll("detail")}
          >
            {right}
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function DetailSheet({ model, onClose }: { model: ModelView; onClose: () => void }) {
  const props = useApp((s) => s.modelProps[model.section]);
  const loadModelProps = useApp((s) => s.loadModelProps);
  const presetText = useApp((s) => s.presetText);

  useEffect(() => {
    if (model.status === "loaded") {
      void loadModelProps(model.section);
    }
  }, [model.section, model.status, loadModelProps]);

  const section = useMemo(() => sectionText(presetText, model.section), [presetText, model.section]);
  const modalities = props?.modalities;
  const modalityText = modalities
    ? [modalities.vision ? "视觉" : null, modalities.audio ? "音频" : null, modalities.video ? "视频" : null]
        .filter(Boolean)
        .join("、") || "纯文本"
    : "—";

  return (
    <Modal
      title={`模型详情 · ${model.name}`}
      icon={getModelIcon(model.name, model.id, model.scanned?.dir)}
      onClose={onClose}
      bodyClass="model-detail"
      footer={
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="form-text mono" style={{ marginTop: 0, marginBottom: "1rem" }}>
        {model.id}
      </div>

      <div className="grid2">
        <div className="info-card">
          <div className="k">状态</div>
          <div>
            {model.status}
            {model.port != null && <> · 实例端口 {model.port}</>}
            {model.failed && model.exitCode != null && <> · 退出码 {model.exitCode}</>}
          </div>
        </div>
        <div className="info-card">
          <div className="k">量化（扫描推断）</div>
          <div>{model.quantization ?? "未知"}</div>
        </div>
        <div className="info-card">
          <div className="k">量化（运行态 /props）</div>
          <div>{props?.model_ftype ?? (model.status === "loaded" ? "读取中…" : "未加载")}</div>
        </div>
        <div className="info-card">
          <div className="k">上下文 / 槽位</div>
          <div>
            {props?.default_generation_settings?.n_ctx ?? "—"} / {props?.total_slots ?? "—"}
          </div>
        </div>
        <div className="info-card">
          <div className="k">模态</div>
          <div>{modalityText}</div>
        </div>
        <div className="info-card">
          <div className="k">构建</div>
          <div className="mono">{props?.build_info ?? "—"}</div>
        </div>
      </div>

      <div className="form-group" style={{ marginTop: "1.25rem" }}>
        <label className="form-label">presets.ini 中的该段</label>
        {section ? (
          <div className="code-block">{section}</div>
        ) : (
          <div className="form-text" style={{ marginTop: 0 }}>
            该模型还没有 preset 段，可在「配置」里保存后生成。
          </div>
        )}
      </div>

      {model.scanned?.mmproj && (
        <div className="form-group">
          <label className="form-label">多模态投影文件</label>
          <div className="code-block">{model.scanned.mmproj}</div>
          <small className="form-text">
            与主模型同目录、文件名以 <code>mmproj</code> 开头时会被 router 自动识别。
          </small>
        </div>
      )}
    </Modal>
  );
}
