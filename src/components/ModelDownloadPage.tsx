/**
 * 「模型下载」页（导航栏 → 模型下载）。
 *
 * 页面结构照搬上游 strata-manager 的 `apps/desktop/src/pages/ModelDownloadPage.tsx`：
 * 顶部工具栏（使用已有模型 / 下载配置 / 下载任务，三个都开弹窗）、模型列表 + 详情
 * （量化表带本机适配刻度与速度估算 → 启动预设 → 资源预估）、底部提交条。
 *
 * 与上游的差别只在**执行方式**：
 * - 上游调自己的 native 下载器（`runtime-core` 的 setup 通道）；
 * - 这里非交互跑官方安装器 `setup.py --family … --yes --no-start`（见
 *   `src-tauri/src/strata_download.rs`），进度由安装器的 `\r` 行翻译而来。
 *
 * 组件文件只导出组件（铁律 7），纯函数都在 `src/utils/modelCatalog.ts` 与
 * `src/utils/modelPerformance.ts`。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { ipc } from "../ipc";
import { useApp } from "../store";
import type {
  StrataCommunityModel,
  StrataDownloadDisk,
  StrataDownloadSnapshot,
  StrataHostInfo,
  StrataLocalGguf,
  StrataMtpCheck,
  StrataOrcaProbe,
  StrataOrcaSnapshot,
} from "../types";
import {
  CONTEXT_MAX,
  CONTEXT_MIN,
  DOWNLOAD_CONTEXT_PRESETS,
  MODEL_CATALOG,
  applyControlCatalog,
  catalogQuantEngineGate,
  catalogReleaseGate,
  deepseek41DiskNeedGB,
  deepseek41HasCard,
  deepseek41MemoryClass,
  diskNeedBytes,
  downloadGBOf,
  familyDescription,
  familyOfName,
  fitOf,
  formatContextTokens,
  isExtendedContext,
  quantOfName,
  recommendDeepseek41,
  usableMemoryGb,
  weightsGBOf,
  type CatalogModel,
} from "../utils/modelCatalog";
import {
  kindLabel,
  mergeCommunityModels,
  riskLabel,
  setupFamilyOf,
} from "../utils/communityCatalog";
import { basisLabel, estimatePerformance, formatRange, hardwareOf } from "../utils/modelPerformance";
import { fmtSize } from "../utils/models";
import { Modal } from "./Sheet";

/** 「下载并准备」记下的公共配置（照搬上游 MODEL_DOWNLOAD_DEFAULTS_KEY 的语义） */
interface DownloadPrefs {
  /** `auto` / `modelscope` / `huggingface` */
  source: "auto" | "modelscope" | "huggingface";
  /** HF 镜像（走 `HF_ENDPOINT` 环境变量） */
  hfEndpoint: string;
  /** `cuda` / `hip` / `sycl`，空 = 交给安装器判断 */
  backend: string;
  /** 显卡编号（nvidia-smi 的号），空 = 自动 */
  gpu: string;
  /** 下载落地目录（`--data-dir`），空 = 控制端默认数据目录 */
  dataDir: string;
}

const PREFS_KEY = "modelDownloadDefaultsV1";

const DEFAULT_PREFS: DownloadPrefs = { source: "auto", hfEndpoint: "", backend: "", gpu: "", dataDir: "" };

function loadPrefs(): DownloadPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<DownloadPrefs>;
    return {
      source:
        parsed.source === "modelscope" || parsed.source === "huggingface" ? parsed.source : "auto",
      hfEndpoint: typeof parsed.hfEndpoint === "string" ? parsed.hfEndpoint : "",
      backend: typeof parsed.backend === "string" ? parsed.backend : "",
      gpu: typeof parsed.gpu === "string" ? parsed.gpu : "",
      dataDir: typeof parsed.dataDir === "string" ? parsed.dataDir : "",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 每个家族各自记住的量化/上下文/图像选择（切来切去不丢） */
type Selection = { quant: string; context: number; images: boolean };

function initialSelection(model: CatalogModel): Selection {
  return {
    quant: model.quants[0] ?? "",
    context: model.fixedContext ?? DOWNLOAD_CONTEXT_PRESETS[0],
    images: model.images,
  };
}

const FIT_LABEL: Record<"fits" | "tight" | "over" | "unknown", string> = {
  fits: "适配",
  tight: "偏紧",
  over: "不足",
  unknown: "未知",
};

/** 顶栏三个按钮各自对应的弹窗 */
type Sheet = "prefs" | "local" | "tasks" | "evidence" | null;

/** 本地 GGUF 目录的分组结果：一个量化一行，分片合起来算总量。 */
interface LocalGroup {
  quant: string;
  family: string | null;
  bytes: number;
  shards: number;
  /** 去掉量化名与分片号之后的基名，当卡片标题用 */
  base: string;
}

function localGroupsOf(files: StrataLocalGguf[]): LocalGroup[] {
  const groups = new Map<string, LocalGroup>();
  for (const file of files) {
    const quant = quantOfName(file.name);
    if (!quant) continue;
    const family = familyOfName(file.name, quant);
    const base = file.name
      .replace(/\.gguf$/i, "")
      .replace(/-\d{5}-of-\d{5}$/i, "")
      .replace(new RegExp(`-${quant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), "")
      // Gyro 的量化名后面还跟着打包格式（`Gyro-S-TQ1_0`），基名里一并去掉
      .replace(/-tq1_0$/i, "");
    const current = groups.get(quant);
    if (current) {
      current.bytes += file.bytes;
      current.shards = Math.max(current.shards, file.shards);
    } else {
      groups.set(quant, { quant, family, bytes: file.bytes, shards: file.shards, base });
    }
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

/**
 * 从设置里保存的引擎 exe 路径取组件版本目录名：
 * `…\engine\0.1.52-windows-x86_64-cuda-cuda13\strata.exe` → `0.1.52`。
 * 读设置里记的值，避免进页面就扫一遍引擎目录（用户 m02766）。
 */
function versionFromEnginePath(path: string | null | undefined): string | null {
  const match = /[\\/]engine[\\/]([^\\/]+)[\\/]/i.exec((path ?? "").trim());
  const folder = match?.[1];
  return folder ? folder.split("-")[0] || null : null;
}

export function ModelDownloadPage({ onNavigate }: { onNavigate?: (tab: "models" | "settings") => void }) {
  const setNotice = useApp((s) => s.setNotice);
  // 设置里已保存的控制端 / 引擎选择：进页面直接用它，不重新扫描（用户 m02766）
  const settings = useApp((s) => s.settings);

  const [prefs, setPrefs] = useState<DownloadPrefs>(loadPrefs);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>(MODEL_CATALOG[0]?.id ?? "");
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [detailOpen, setDetailOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setLocalError] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(true);

  const [host, setHost] = useState<StrataHostInfo | null>(null);
  // 控制端 `setup.py` 的目录参考值（参考 RAM / 体积）。后端只在控制端版本变了时才读一次
  // （用户 m01170），这里拿到的可能直接是缓存；`catalogMeta` 更新触发一次重渲染让数值生效。
  const [catalogMeta, setCatalogMeta] = useState<{ version: string; applied: number } | null>(null);
  const [disk, setDisk] = useState<StrataDownloadDisk | null>(null);
  const [diskToken, setDiskToken] = useState(0);
  const [snapshot, setSnapshot] = useState<StrataDownloadSnapshot | null>(null);
  const [pollToken, setPollToken] = useState(0);

  // 本地 GGUF（「使用已有模型」弹窗）
  const [localDir, setLocalDir] = useState("");
  const [localFiles, setLocalFiles] = useState<StrataLocalGguf[] | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [localQuant, setLocalQuant] = useState("");
  const [localContext, setLocalContext] = useState(32768);
  // MTP 草稿层（可选）：安装器只在 `<数据目录>\mtp\rt` 找它，选中后把数据目录换成它所在的上级目录
  const [mtpPath, setMtpPath] = useState("");
  const [mtpCheck, setMtpCheck] = useState<StrataMtpCheck | null>(null);
  const [mtpOpen, setMtpOpen] = useState(false);

  // 社区目录（官方目录之外的第二档；发现结果后端缓存 24 小时）
  const [scope, setScope] = useState<"official" | "community">("official");
  const [community, setCommunity] = useState<StrataCommunityModel[]>(mergeCommunityModels([]));
  const [communityState, setCommunityState] = useState<"idle" | "loading" | "fresh" | "cached" | "stale" | "offline">("idle");
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [communityId, setCommunityId] = useState<string>(mergeCommunityModels([])[0]?.id ?? "");
  const [communityQuants, setCommunityQuants] = useState<Record<string, string>>({});
  // 社区条目的启动预设（上下文 / 图像）——与官方条目同一套交互，按条目 id 各存一份
  const [communitySelections, setCommunitySelections] = useState<
    Record<string, { context: number; images: boolean }>
  >({});

  // ORCA（社区档里 family === "orca" 的那一条走自己的三步流程）
  const [orcaProbe, setOrcaProbe] = useState<StrataOrcaProbe | null>(null);
  const [orca, setOrca] = useState<StrataOrcaSnapshot | null>(null);
  const [orcaToken, setOrcaToken] = useState(0);

  const taskRef = useRef<HTMLDivElement | null>(null);

  const selected = MODEL_CATALOG.find((entry) => entry.id === selectedId) ?? MODEL_CATALOG[0];
  const selection = useMemo<Selection>(
    () => selections[selected?.id ?? ""] ?? initialSelection(selected ?? MODEL_CATALOG[0]),
    [selections, selected],
  );

  // 控制端 / 引擎版本一律读设置里已保存的选择，进页面不再重新扫描控制端目录（用户 m02766）
  const controllerVersion = (settings?.strata_controller ?? "").trim() || null;
  // 引擎组件版本（`0.1.52` 这条线）：单个量化的 minEngine 门禁用它；从已选 exe 路径里取版本目录名
  const engineVersion = useMemo(() => {
    const picked = versionFromEnginePath(settings?.strata_engine);
    return picked ?? controllerVersion;
  }, [settings?.strata_engine, controllerVersion]);
  // Strata 发布版本（`0.2.7` 这条线）：家族级 minRelease 门禁用它；读不到就不拦
  const strataRelease = host?.release ?? null;
  // 有没有可用的控制端：只看设置里记的根目录，不再每次扫控制端列表
  const configuredRoot = (settings?.strata_root ?? "").trim();

  const memoryGB = host?.memoryGb ?? null;
  const vramGB = host?.vramGb ?? null;
  const hardware = useMemo(() => hardwareOf(host), [host]);
  const usableGB = usableMemoryGb(memoryGB, vramGB);

  // 社区档的选中项与当前量化
  const selectedCommunity =
    community.find((model) => model.id === communityId) ?? community[0];
  const communityQuant = selectedCommunity
    ? (communityQuants[selectedCommunity.id] ?? selectedCommunity.quants[0] ?? "")
    : "";
  const communityInfo = selectedCommunity?.quantInfo[communityQuant];
  const communitySelection = (selectedCommunity ? communitySelections[selectedCommunity.id] : undefined) ?? {
    context: 32768,
    images: false,
  };
  const updateCommunitySelection = useCallback(
    (patch: Partial<{ context: number; images: boolean }>) => {
      if (!selectedCommunity) return;
      setCommunitySelections((previous) => ({
        ...previous,
        [selectedCommunity.id]: { ...(previous[selectedCommunity.id] ?? { context: 32768, images: false }), ...patch },
      }));
    },
    [selectedCommunity],
  );

  /** 社区列表的搜索过滤（搜名字或仓库全名）。 */
  const communityList = useMemo(() => {
    const text = query.trim().toLowerCase();
    return community.filter(
      (model) =>
        !text ||
        model.name.toLowerCase().includes(text) ||
        model.repo.toLowerCase().includes(text),
    );
  }, [community, query]);

  /** 拉社区目录；`force` = 用户点了刷新（跳过后端 24 小时缓存）。 */
  const loadCommunity = useCallback(
    async (force = false) => {
      setCommunityState("loading");
      setCommunityError(null);
      try {
        const result = await ipc.strataCommunityDiscover(force, prefs.hfEndpoint.trim() || null);
        setCommunity(mergeCommunityModels(result.entries));
        setCommunityState(result.state);
        setCommunityError(result.error);
      } catch (err) {
        setCommunityState("offline");
        setCommunityError(err instanceof Error ? err.message : String(err));
      }
    },
    [prefs.hfEndpoint],
  );

  /** 社区模型的下载：仍然交给官方安装器（社区条目的家族都在 `setup.py` 的白名单里）。 */
  const startCommunity = useCallback(async () => {
    if (!selectedCommunity || !communityQuant) {
      return;
    }
    if (!setupFamilyOf(selectedCommunity.family)) {
      setLocalError("这条模型要走 ORCA 通道，官方安装器不认它的参数，请按面板里的说明用官方安装器导入。");
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      const context = communitySelection.context;
      const images = communitySelection.images && selectedCommunity.images;
      const need = Math.round((communityInfo?.downloadGb ?? 0) * 2e9) + (images ? 1_000_000_000 : 0);
      if (need > 0) {
        const check = await ipc.strataDownloadPreflight(need, prefs.dataDir.trim() || null);
        if (check.status !== "ready") {
          setLocalError(
            check.status === "insufficient"
              ? "磁盘空间不足，请检查存储位置或清理空间。"
              : "磁盘空间尚未核验，请重新检查。",
          );
          return;
        }
      }
      const result = await ipc.strataDownloadStart({
        family: selectedCommunity.family,
        quant: communityQuant,
        context,
        images,
        source: prefs.source === "auto" ? null : prefs.source,
        hfEndpoint: prefs.hfEndpoint.trim() || null,
        dataDir: prefs.dataDir.trim() || null,
        backend: prefs.backend || null,
        gpu: prefs.gpu.trim() || null,
      });
      setNotice(result.message);
      setPollToken((token) => token + 1);
      setSheet("tasks");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [selectedCommunity, communityQuant, communityInfo, communitySelection, prefs, setNotice]);

  /** ORCA：下载两个分片 → iq_pack 打包 → 写配置（后端一次跑三步）。 */
  const startOrca = useCallback(async () => {
    setSubmitting(true);
    setLocalError(null);
    try {
      const result = await ipc.strataOrcaStart();
      setNotice(result.message);
      setOrcaToken((token) => token + 1);
      setSheet("tasks");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [setNotice]);

  const cancelOrca = useCallback(async () => {
    try {
      await ipc.strataOrcaStop();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const releaseGate = selected ? catalogReleaseGate(selected.family, strataRelease) : null;
  const blocked = releaseGate !== null && !releaseGate.ok;
  const quantGate = selected
    ? catalogQuantEngineGate(selected.family, selection.quant, engineVersion)
    : null;
  const quantBlocked = quantGate !== null && !quantGate.ok;

  // 首次挂载：只读本机信息（内存 / 显卡 / Strata 发布版本）与当前下载进度。
  // 控制端与引擎版本来自设置，不再每次重新扫描（用户 m02766）。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const hostInfo = await ipc.strataDownloadHost();
        if (!alive) return;
        setHost(hostInfo);
      } catch (err) {
        if (alive) setLocalError(String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 控制端目录参考值：与上面同一次挂载里读。
  //
  // 用户 m01170：不要每次启动都跑一遍安装器 —— 读取时机全在后端判断（控制端目录名变了才真读），
  // 这里只负责把结果套进 `MODEL_CATALOG`，让「参考 RAM / 体积 / 适配」跟着控制端走（用户 m00985）。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const snapshot = await ipc.strataControlCatalog();
        if (!alive) return;
        const result = applyControlCatalog(snapshot);
        setCatalogMeta({ version: result.version, applied: result.applied });
      } catch {
        // 没装控制端 / 解释器坏了：保留快照值，页脚那句「以所选控制端为准」仍然成立
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 进度轮询：有任务时每秒一次，跑完停
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await ipc.strataDownloadStatus();
        if (!alive) return;
        setSnapshot(next.phase ? next : null);
        if (next.running) timer = window.setTimeout(tick, 1000);
      } catch {
        if (alive) timer = window.setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [pollToken]);

  // ORCA 前置探测：只做一次（缺什么由面板列出来）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const probe = await ipc.strataOrcaProbe();
        if (alive) setOrcaProbe(probe);
      } catch {
        // 面板会显示「不可用」，这里不打断主流程
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ORCA 进度轮询：与下载轮询分开（两条链路的子进程互不相干）
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await ipc.strataOrcaStatus();
        if (!alive) return;
        setOrca(next.phase ? next : null);
        if (next.running) timer = window.setTimeout(tick, 1000);
      } catch {
        if (alive) timer = window.setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [orcaToken]);

  // 选择变化（或点了刷新、开了图像支持）→ 重算磁盘需求
  useEffect(() => {
    if (!selected || !selection.quant) return;
    let alive = true;
    // 勾了图像支持还要多落一份图像投影器（mmproj 约 1 GB）
    const need = diskNeedBytes(selected.family, selection.quant) + (selection.images ? 1_000_000_000 : 0);
    void (async () => {
      try {
        const result = await ipc.strataDownloadPreflight(need, prefs.dataDir.trim() || null);
        if (alive) setDisk(result);
      } catch {
        if (alive) setDisk(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected, selection.quant, selection.images, diskToken, prefs.dataDir]);

  const pick = useCallback((model: CatalogModel) => {
    setSelectedId(model.id);
    setDetailOpen(true);
    setSelections((previous) => (previous[model.id] ? previous : { ...previous, [model.id]: initialSelection(model) }));
  }, []);

  const updateSelection = useCallback(
    (patch: Partial<Selection>) => {
      if (!selected) return;
      setSelections((previous) => ({
        ...previous,
        [selected.id]: { ...(previous[selected.id] ?? initialSelection(selected)), ...patch },
      }));
    },
    [selected],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return MODEL_CATALOG;
    return MODEL_CATALOG.filter((model) =>
      `${model.name} ${model.family} ${model.quants.join(" ")}`.toLowerCase().includes(needle),
    );
  }, [query]);

  const downloadGB = selected ? downloadGBOf(selected.family, selection.quant) : 0;
  const running = snapshot?.running ?? false;
  const orcaRunning = orca?.running ?? false;

  const start = useCallback(
    async (options?: { ggufDir?: string; family?: string; quant?: string; context?: number; images?: boolean; dataDir?: string }) => {
      if (!selected) return;
      const family = options?.family ?? selected.family;
      const quant = options?.quant ?? selection.quant;
      const context = options?.context ?? selection.context;
      // 与上游 snapshotModelDownloadRequest 同一套校验：上下文区间、固定上下文、图像支持
      if (!Number.isInteger(context) || context < CONTEXT_MIN || context > CONTEXT_MAX) {
        setLocalError(`上下文长度须为 ${CONTEXT_MIN}–${CONTEXT_MAX} 的整数`);
        return;
      }
      if (selected.fixedContext && context !== selected.fixedContext) {
        setLocalError(`${selected.name} 只支持 ${selected.fixedContext} 上下文`);
        return;
      }
      if (blocked) {
        setLocalError(`需要 Strata ${releaseGate?.minRelease}+（当前 ${strataRelease ?? "未读到发布版本"}）`);
        return;
      }
      if (!options?.ggufDir && quantBlocked) {
        setLocalError(`这个量化需要引擎 ${quantGate?.minEngine}+（当前 ${engineVersion ?? "未知"}）`);
        return;
      }
      if (!options?.ggufDir) {
        try {
          const preflight = await ipc.strataDownloadPreflight(diskNeedBytes(family, quant), prefs.dataDir.trim() || null);
          setDisk(preflight);
          if (preflight.status !== "ready") {
            setLocalError(
              preflight.status === "insufficient"
                ? "磁盘空间不足，请清理模型目录所在的卷或换存储位置"
                : "磁盘空间尚未核验（未找到 Strata 目录？），请检查后重试",
            );
            return;
          }
        } catch (err) {
          setLocalError(String(err));
          return;
        }
      }
      setSubmitting(true);
      setLocalError(null);
      try {
        const result = await ipc.strataDownloadStart({
          family,
          quant,
          context,
          images: options?.ggufDir ? false : (options?.images ?? selection.images),
          ggufDir: options?.ggufDir ?? null,
          source: prefs.source,
          hfEndpoint: prefs.hfEndpoint.trim() || null,
        dataDir: options?.dataDir ?? (prefs.dataDir.trim() || null),
          backend: prefs.backend || null,
          gpu: prefs.gpu || null,
        });
        setNotice(result.message || "已开始下载");
        setPollToken((token) => token + 1);
        setSheet("tasks");
      } catch (err) {
        setLocalError(String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [
      blocked,
      engineVersion,
      prefs,
      quantBlocked,
      quantGate?.minEngine,
      releaseGate?.minRelease,
      engineVersion,
      selected,
      selection,
      setNotice,
    ],
  );

  const cancel = useCallback(async () => {
    try {
      await ipc.strataDownloadStop();
      setPollToken((token) => token + 1);
    } catch (err) {
      setLocalError(String(err));
    }
  }, []);

  // 下载结束（成功）→ 让「模型」页的 Strata 那档重新扫一遍
  useEffect(() => {
    if (snapshot && !snapshot.running && snapshot.ok === true) {
      void useApp.getState().refreshStrata().catch(() => undefined);
    }
  }, [snapshot]);

  const savePrefs = useCallback((patch: Partial<DownloadPrefs>) => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式下写不进去就算了，本次仍然生效 */
      }
      return next;
    });
  }, []);

  /** 选下载目录：改 `--data-dir`，选完按新卷重算一次磁盘预检。 */
  const pickDataDir = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "选择模型下载目录" });
      if (typeof picked === "string" && picked) {
        savePrefs({ dataDir: picked });
        // 预检用 `prefs.dataDir`，状态还没刷新，先拿这次的值直接查
        const result = await ipc.strataDownloadPreflight(
          selected
            ? diskNeedBytes(selected.family, selection.quant) + (selection.images ? 1_000_000_000 : 0)
            : 0,
          picked,
        );
        setDisk(result);
      }
    } catch (err) {
      setLocalError(String(err));
    }
  }, [savePrefs, selected, selection.quant, selection.images, setDisk]);

  /** 扫目录（返回结果，调用方可直接用）。 */
  const scanDir = useCallback(async (dir: string): Promise<StrataLocalGguf[]> => {
    setLocalBusy(true);
    try {
      const files = await ipc.strataDownloadScanGguf(dir);
      setLocalFiles(files);
      if (files.length === 0) {
        setLocalError("这个目录里没有 GGUF 文件");
        setLocalQuant("");
      } else {
        setLocalError(null);
        // 默认选体量最大的那个量化，和列表排序一致
        setLocalQuant(localGroupsOf(files)[0]?.quant ?? "");
      }
      return files;
    } catch (err) {
      setLocalError(String(err));
      setLocalFiles(null);
      setLocalQuant("");
      return [];
    } finally {
      setLocalBusy(false);
    }
  }, []);

  /** 选目录：选完立刻扫一遍，列表马上有内容。 */
  const browseDir = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "选择放 GGUF 的目录" });
      if (typeof picked === "string" && picked) {
        setLocalDir(picked);
        setLocalFiles(null);
        void scanDir(picked);
      }
    } catch (err) {
      setLocalError(String(err));
    }
  }, [scanDir]);

  /** 选 MTP 草稿层目录（`<x>` / `<x>\rt` / `<x>\mtp\rt` 都接受），选完立刻检查。 */
  const pickMtp = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        title: "选择 MTP 草稿层目录（含 rt\\experts.bin）",
      });
      if (typeof picked !== "string" || !picked) return;
      setMtpPath(picked);
      setMtpOpen(true);
      setMtpCheck(await ipc.strataDownloadCheckMtp(picked));
    } catch (err) {
      setLocalError(String(err));
    }
  }, []);

  /** 「使用已有模型」：从文件名认出家族与量化，交给安装器打包生成配置。 */
  const useLocal = useCallback(async () => {
    const dir = localDir.trim();
    if (!dir) {
      setLocalError("先选放 GGUF 的目录");
      return;
    }
    const files = localFiles && localFiles.length > 0 ? localFiles : await scanDir(dir);
    const groups = localGroupsOf(files);
    const group = groups.find((item) => item.quant === localQuant) ?? groups[0];
    if (!group) {
      setLocalError("认不出文件名里的量化版本，请确认文件名带 IQ3_XXS / UD-Q4_K_XL 这类量化名");
      return;
    }
    if (!group.family) {
      setLocalError("认不出这条模型属于哪个家族（qwen / swift / coder / unsloth）");
      return;
    }
    // MTP 草稿层：安装器只在 `<数据目录>\mtp\rt` 找，所以选了它就把数据目录换成它的上级
    let mtpData: string | undefined;
    if (mtpPath.trim()) {
      const check = mtpCheck ?? (await ipc.strataDownloadCheckMtp(mtpPath.trim()));
      setMtpCheck(check);
      if (check.problems.length > 0) {
        setLocalError(check.problems[0]);
        return;
      }
      if (!check.dataDirectory) {
        setLocalError("安装器只在 <数据目录>\\mtp\\rt 查找 MTP 草稿层；请选择名为 mtp 的目录下的 rt 目录");
        return;
      }
      mtpData = check.dataDirectory;
    }
    setSheet(null);
    await start({
      ggufDir: dir,
      family: group.family,
      quant: group.quant,
      context: localContext,
      dataDir: mtpData,
    });
  }, [localDir, localFiles, localQuant, localContext, mtpPath, mtpCheck, scanDir, start]);

  const localGroups = useMemo(() => localGroupsOf(localFiles ?? []), [localFiles]);
  const localGroup = localGroups.find((item) => item.quant === localQuant) ?? localGroups[0] ?? null;
  // MTP 折叠区右侧的状态字（与上游 mtpAuto / mtpChosen / unusable 一致）
  const mtpState = !mtpPath.trim()
    ? "自动准备"
    : mtpCheck?.problems.length
      ? "不可用"
      : mtpCheck
        ? `已选择 · ${fmtSize(mtpCheck.expertsBytes)}`
        : "检查中…";

  if (!selected) return null;

  // 图像支持要多加载一份投影器（mmproj 约 2 GB 内存/显存），预览值跟着变
  const imagesExtra = selection.images ? 2 : 0;
  // 参考占用按官网口径「显存 + 内存合计」（用户 m01417），判定预算也按同一口径拼出来
  const ramRef = weightsGBOf(selected.family, selection.quant) + imagesExtra;
  const availableGB = host?.availableMemoryGb ?? memoryGB;
  const budgetGB = availableGB != null ? availableGB + (vramGB ?? 0) : null;
  const fit = fitOf(ramRef, budgetGB, null);
  const dsv41 = selected.family === "deepseek41";
  const available = disk?.availableBytes != null ? fmtSize(disk.availableBytes) : "—";
  const diskText =
    disk?.status === "ready" ? "充足" : disk?.status === "insufficient" ? "不足" : "未核验";
  const diskOk = disk?.status === "ready";

  // 刻度尺的最大值：本机预算与最大参考需求取大者，保证每行都落在轴上
  const axisMax = Math.max(
    usableGB ?? 0,
    ...selected.quants.map((quant) => selected.quantInfo[quant]?.weightsGB ?? selected.quantInfo[quant]?.ramGB ?? 0),
    32,
  );
  const estimate = estimatePerformance(selected.family, selection.quant, hardware);

  const taskCount = (running ? 1 : 0) + (orcaRunning ? 1 : 0);

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">模型下载</h1>
        <div className="top-actions">
          <button type="button" className="st-btn st-btn--secondary st-btn--sm" onClick={() => setSheet("local")}>
            <i className="fas fa-folder-open" /> 使用已有模型
          </button>
          <button type="button" className="st-btn st-btn--secondary st-btn--sm" onClick={() => setSheet("prefs")}>
            <i className="fas fa-sliders" /> 下载配置
          </button>
          <button type="button" className="st-btn st-btn--secondary st-btn--sm" onClick={() => setSheet("tasks")}>
            <i className="fas fa-download" /> 下载任务
            {taskCount > 0 && <span className="model-download-count">{taskCount}</span>}
          </button>
        </div>
      </div>

      <div className="page-fill page-fill--scroll model-download-page">
        <section className="model-download-location">
          <span>模型目录</span>
          <code>{disk?.dataDirectory ?? "—"}</code>
          <span>可用 {available}</span>
          {controllerVersion ? <span className="model-download-location-tag">控制器 {controllerVersion}</span> : null}
          {engineVersion ? <span className="model-download-location-tag">引擎 {engineVersion}</span> : null}
          {strataRelease ? <span className="model-download-location-tag">Strata {strataRelease}</span> : null}
        </section>

        {!configuredRoot && (
          <section className="model-download-runtime-needed">
            <p>设置里还没填 Strata 根目录，先到「设置 → 运行环境」选一份才能下载模型。</p>
            <button type="button" className="st-btn st-btn--primary st-btn--sm" onClick={() => onNavigate?.("settings")}>
              去设置
            </button>
          </section>
        )}

        <div className={`model-download-browser${detailOpen ? " is-detail" : ""}`}>
          <div className="model-download-list">
            <label className="model-download-search">
              <i className="fas fa-search" />
              <input
                type="text"
                placeholder="搜索模型…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button type="button" className="model-download-search-clear" title="清除" onClick={() => setQuery("")}>
                  <i className="fas fa-times" />
                </button>
              )}
              <span>{scope === "official" ? filtered.length : communityList.length} 个模型</span>
            </label>
            <div className="model-download-scope">
              <button
                type="button"
                className={`model-download-scope-tab${scope === "official" ? " is-active" : ""}`}
                onClick={() => setScope("official")}
              >
                官方目录
              </button>
              <button
                type="button"
                className={`model-download-scope-tab${scope === "community" ? " is-active" : ""}`}
                onClick={() => {
                  setScope("community");
                  if (communityState === "idle") {
                    void loadCommunity();
                  }
                }}
              >
                社区
              </button>
              {scope === "community" && (
                <button
                  type="button"
                  className="model-download-scope-refresh"
                  title="重新发现（跳过缓存）"
                  disabled={communityState === "loading"}
                  onClick={() => void loadCommunity(true)}
                >
                  <i className={`fas fa-rotate${communityState === "loading" ? " fa-spin" : ""}`} />
                </button>
              )}
            </div>
            <div className="model-download-models">
              {scope === "official" ? (
                <>
                  {filtered.map((model) => {
                    const gate = catalogReleaseGate(model.family, strataRelease);
                    const unusable = gate !== null && !gate.ok;
                    return (
                      <button
                        type="button"
                        key={model.id}
                        className={`model-download-model${model.id === selected.id ? " is-selected" : ""}${unusable ? " is-disabled" : ""}`}
                        onClick={() => pick(model)}
                      >
                        <span className="model-download-model-icon">
                          <i className={`fas ${dsv41Icon(model.family)}`} />
                        </span>
                        <span className="model-download-model-copy">
                          <strong>{model.name}</strong>
                          <span>{familyDescription(model.family)}</span>
                          <small>
                            {model.quants.length} 个量化版本 ·{" "}
                            {Math.min(
                              ...model.quants.map(
                                (quant) => model.quantInfo[quant]?.weightsGB ?? model.quantInfo[quant]?.ramGB ?? 0,
                              ),
                            )}{" "}
                            GB 起（显存 + 内存）
                          </small>
                        </span>
                        {unusable ? (
                          <span className="model-download-model-tag">需 {gate?.minRelease}+</span>
                        ) : (
                          <i className="fas fa-chevron-right" />
                        )}
                      </button>
                    );
                  })}
                  {filtered.length === 0 && <p className="model-download-empty">没有匹配的模型</p>}
                </>
              ) : (
                <>
                  {communityList.map((model) => (
                    <button
                      type="button"
                      key={model.id}
                      className={`model-download-model${model.id === selectedCommunity?.id ? " is-selected" : ""}`}
                      onClick={() => {
                        setCommunityId(model.id);
                        setDetailOpen(true);
                      }}
                    >
                      <span className="model-download-model-icon">
                        <i className="fas fa-box" />
                      </span>
                      <span className="model-download-model-copy">
                        <strong>{model.name}</strong>
                        <span className="model-download-model-meta">
                          <em className="model-download-badge is-community">社区 · 无审查</em>
                          <span>{model.repo.split("/")[0]}</span>
                          {model.source === "discovered" ? <em className="model-download-badge">自动发现</em> : null}
                        </span>
                        <small>
                          {model.quants.length} 个量化版本 ·{" "}
                          {Math.min(...model.quants.map((name) => model.quantInfo[name]?.downloadGb ?? 0))} GB 起
                        </small>
                      </span>
                      {model.kind === "orca" ? <span className="model-download-model-tag">ORCA 导入</span> : null}
                      <i className="fas fa-chevron-right" />
                    </button>
                  ))}
                  {communityState === "loading" && communityList.length === 0 && (
                    <p className="model-download-empty">正在发现社区模型…</p>
                  )}
                  {(communityState === "offline" || communityState === "stale") && (
                    <p className="model-download-error">
                      没能连上模型站{communityError ? `：${communityError}` : ""}。可以在「下载配置」里填 HF 镜像后重试。
                    </p>
                  )}
                  {communityState !== "loading" && communityList.length === 0 && communityState !== "offline" && communityState !== "stale" && (
                    <p className="model-download-empty">没有匹配的社区模型</p>
                  )}
                </>
              )}
            </div>
            <p className="model-download-catalog-note">
              {scope === "official"
                ? catalogMeta
                  ? `参考占用取官网 MODELS.md 的「显存 + 内存」口径（快照 ${selected.snapshotDate}）；下载体积随控制端 ${catalogMeta.version} 更新。`
                  : `参考占用取官网 MODELS.md 的「显存 + 内存」口径（快照 ${selected.snapshotDate}），实际支持以所选控制端为准。`
                : "社区条目同样交给官方安装器下载；ORCA 通道需要官方安装器，面板里给了说明。"}
            </p>
          </div>

          <div className="model-download-detail">
            <button type="button" className="model-download-back" onClick={() => setDetailOpen(false)}>
              <i className="fas fa-arrow-left" /> 返回列表
            </button>
            {scope === "official" ? (
              <>
                <div className="model-download-detail-body">
                  <div className="model-download-detail-heading">
                    <span className="model-download-family">{selected.family}</span>
                    <h3>{selected.name}</h3>
                    <a href={selected.source} target="_blank" rel="noreferrer">
                      官方目录 <i className="fas fa-arrow-up-right-from-square" />
                    </a>
                  </div>
                  <p className="model-download-desc">{familyDescription(selected.family)}</p>

                  {blocked && (
                    <p className="model-download-blocked">
                      这个家族需要 Strata {releaseGate?.minRelease}+，当前是 {strataRelease ?? "未读到发布版本"}。
                      先去「设置 → 运行环境」升级。
                    </p>
                  )}

                  <fieldset className="model-download-variants">
                    <legend>1. 选择量化版本</legend>
                    <div className="model-download-variant-head">
                      <span>量化</span>
                      <span>下载大小</span>
                      <span>{`参考占用（显存 + 内存）`}</span>
                      <span>本机 {memoryGB ? Math.round(memoryGB) : "—"} GB</span>
                      <span>速度（估算）</span>
                    </div>
                    {selected.quants.map((quant) => {
                      const info = selected.quantInfo[quant] ?? { downloadGB: 0, ramGB: 0 };
                      const gate = catalogQuantEngineGate(selected.family, quant, engineVersion);
                      const rowBlocked = gate !== null && !gate.ok;
                      const rowRam = info.weightsGB ?? info.ramGB;
                      const rowFit = fitOf(rowRam, budgetGB, null);
                      const rowEstimate = estimatePerformance(selected.family, quant, hardware);
                      const rowSpeed = formatRange(rowEstimate.decode, rowEstimate.bound);
                      const rowFirst = formatRange(rowEstimate.ttft4k);
                      return (
                        <label
                          key={quant}
                          className={`model-download-variant${rowBlocked ? " is-blocked" : ""}`}
                        >
                          <span className="model-download-variant-name">
                            <input
                              type="radio"
                              name="model-download-quant"
                              checked={selection.quant === quant}
                              disabled={rowBlocked}
                              onChange={() => updateSelection({ quant })}
                            />
                            <b>{quant}</b>
                            {quant === selected.quants[0] ? (
                              <small className="model-download-badge is-start">起步版本</small>
                            ) : null}
                            {info.experimental ? <small className="model-download-badge">实验</small> : null}
                            {info.manualOnly ? <small className="model-download-badge">仅手动</small> : null}
                            {info.qualityLoss ? <small className="model-download-badge">质量 {info.qualityLoss}</small> : null}
                            {rowBlocked ? <small className="model-download-badge">需引擎 {gate?.minEngine}+</small> : null}
                          </span>
                          <span>{info.downloadGB} GB</span>
                          <span className="model-download-mem">
                            {rowRam} GB
                          </span>
                          <span className="model-download-axis">
                            <progress value={rowRam} max={axisMax} />
                            <small className={`model-download-fit is-${rowFit}`}>{FIT_LABEL[rowFit]}</small>
                          </span>
                          <span className="model-download-est">
                            {rowSpeed ? (
                              <span className="model-download-est-main"><b>{rowSpeed}</b><small> tok/s</small></span>
                            ) : (
                              <span>—</span>
                            )}
                            {rowFirst ? <em className="model-download-est-badge">估算 · 首字 {rowFirst} s</em> : null}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  <p className="model-download-basis">
                    {estimate.basis === "none" ? "没有对应的实测机型，速度暂时给不出。" : `参考 ${basisLabel(estimate.basis)}`}
                  </p>

                  {(selected.quantInfo[selection.quant]?.nvidiaOnly || selected.quantInfo[selection.quant]?.visionUntested) && (
                    <p className="model-download-variant-warning">
                      {selected.quantInfo[selection.quant]?.nvidiaOnly ? "仅支持 NVIDIA 显卡。" : ""}
                      {selected.quantInfo[selection.quant]?.visionUntested ? "图像能力未验证。" : ""}
                    </p>
                  )}

                  {dsv41 && (
                    <div className="model-download-dsv41">
                      <b>
                        DeepSeek：内存档位 {deepseek41MemoryClass(selection.quant, memoryGB)}
                        {deepseek41HasCard(host?.gpus) === false ? " · 未检测到独立显卡" : ""}
                      </b>
                      <p>
                        磁盘需约 {deepseek41DiskNeedGB(selection.quant) ?? "—"} GB（含 6 GB 余量）；
                        推荐量化 {recommendDeepseek41(memoryGB, disk?.availableBytes ? disk.availableBytes / 1e9 : null)}。
                        2.25 bpw 不会被自动推荐。
                      </p>
                    </div>
                  )}

                  <section className="model-download-preset-card">
                    <div className="model-download-preset-head">
                      <b>
                        <i className="fas fa-sliders" /> 启动预设
                      </b>
                      <span className="model-download-preset-summary">
                        {formatContextTokens(selection.context)} 上下文 · {selection.images ? "图像开启" : "图像关闭"}
                      </span>
                      <button
                        type="button"
                        className="model-download-preset-toggle"
                        title={presetOpen ? "收起" : "展开"}
                        onClick={() => setPresetOpen((open) => !open)}
                      >
                        <i className={`fas fa-chevron-${presetOpen ? "up" : "down"}`} />
                      </button>
                    </div>
                    {presetOpen && (
                      <div className="model-download-preset-body">
                        {selected.fixedContext ? (
                          <p className="model-download-preset-locked">
                            这个模型固定 {selected.fixedContext} 上下文（安装器不接受别的值）。
                          </p>
                        ) : (
                          <div className="model-download-context-presets">
                            {/* 384K / 512K / 1M 三个「实验性」档用户要求去掉，只留常用三档。
                                标签外观照性能测试页「测试计划」的 .st-tier：前面带勾选框、选中时淡绿底，
                                但尺寸按下载页原来那套（28px 高 / 12px 字），不跟着放大（用户 m00888）。 */}
                            {DOWNLOAD_CONTEXT_PRESETS.filter((preset) => !isExtendedContext(preset)).map((preset) => {
                              const on = selection.context === preset;
                              return (
                                <button
                                  key={preset}
                                  type="button"
                                  className={on ? "is-active" : ""}
                                  onClick={() => updateSelection({ context: preset })}
                                >
                                  <span className="st-tier__box">{on && <i className="fas fa-check" />}</span>
                                  {formatContextTokens(preset)}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <div className="model-download-preset-row">
                          <label className="model-download-context-field">
                            <span>上下文长度</span>
                            <input
                              type="number"
                              className="form-control"
                              min={CONTEXT_MIN}
                              max={CONTEXT_MAX}
                              value={selection.context}
                              // 固定上下文的模型不接受别的值：这里直接禁掉，别让用户改完
                              // 到提交时才发现被拒（审查发现）
                              disabled={Boolean(selected.fixedContext)}
                              onChange={(e) => updateSelection({ context: Number(e.target.value) || CONTEXT_MIN })}
                            />
                          </label>
                          <label className="model-download-image-toggle">
                            <span>启用图像支持</span>
                            <input
                              type="checkbox"
                              className="switch-input"
                              checked={selection.images}
                              disabled={!selected.images}
                              onChange={(e) => updateSelection({ images: e.target.checked })}
                            />
                          </label>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="model-download-assess-card">
                    <div className="model-download-assess-head">
                      <b>当前选择的资源预估</b>
                      <span className={`model-download-fit is-${fit}`}>{FIT_LABEL[fit]}</span>
                      <button
                        type="button"
                        className="model-download-assess-help"
                        onClick={() => setSheet("evidence")}
                      >
                        <i className="fas fa-circle-question" /> 查看分项与依据
                      </button>
                      <button
                        type="button"
                        className="model-download-assess-refresh"
                        title="重新核验磁盘"
                        onClick={() => setDiskToken((token) => token + 1)}
                      >
                        <i className="fas fa-rotate" />
                      </button>
                    </div>
                    <div className="model-download-assess-cols">
                      <div>
                        <span>本机可用 RAM</span>
                        <b>
                          {host?.availableMemoryGb != null
                            ? `${host.availableMemoryGb.toFixed(2)} GiB`
                            : memoryGB
                              ? `共 ${Math.round(memoryGB)} GB`
                              : "—"}
                        </b>
                      </div>
                      <div>
                        <span>官网参考占用（显存 + 内存）</span>
                        <b>
                          {ramRef} GiB
                          {imagesExtra > 0 && <small> 含图像 {imagesExtra} GB</small>}
                        </b>
                      </div>
                      <div>
                        <span>磁盘空间</span>
                        <b className={diskOk ? "is-ok" : "is-bad"}>{diskText}</b>
                      </div>
                    </div>
                    <p className="model-download-assess-note">
                      估算：参考值不等于运行保证，长上下文可能增加占用。
                    </p>
                  </section>
                </div>

                <footer className="model-download-submit" ref={taskRef}>
                  {error && <p className="model-download-error">{error}</p>}
                  {running && snapshot && (
                    <div className="model-download-inline">
                      <progress
                        className="model-download-progress"
                        value={Math.round(snapshot.percent)}
                        max={100}
                      />
                      <span>
                        {PHASE_LABEL[snapshot.phase] ?? snapshot.phase} ·{" "}
                        {Math.round(snapshot.percent)}%
                      </span>
                      <button
                        type="button"
                        className="st-btn st-btn--secondary st-btn--sm"
                        onClick={() => setSheet("tasks")}
                      >
                        <i className="fas fa-list-check" /> 任务
                      </button>
                    </div>
                  )}
                  <div className="model-download-submit-row">
                    <span>
                      已选择 {selected.name} · {selection.quant} · {formatContextTokens(selection.context)}
                      {selection.images ? " · 图像" : ""}
                    </span>
                    <button
                      type="button"
                      className="st-btn st-btn--primary"
                      disabled={submitting || running || blocked || quantBlocked}
                      onClick={() => void start()}
                    >
                      {submitting ? "正在检查并提交…" : `下载并准备 · ${downloadGB} GB`}
                    </button>
                  </div>
                  <small>
                    下载 → 打包 → 生成配置，完成后在「模型」页手动启用。
                    {running ? "（正在下载时不能提交新任务）" : ""}
                  </small>
                </footer>
              </>
            ) : (
              <CommunityPane
                model={selectedCommunity}
                quant={communityQuant}
                onQuant={(quant) =>
                  selectedCommunity &&
                  setCommunityQuants((prev) => ({ ...prev, [selectedCommunity.id]: quant }))
                }
                disk={disk}
                hardware={hardware}
                memoryGB={memoryGB}
                vramGB={vramGB}
                submitting={submitting}
                running={running}
                error={error}
                snapshot={snapshot}
                onStart={() => void startCommunity()}
                taskRef={taskRef}
                orcaProbe={orcaProbe}
                orca={orca}
                orcaSubmitting={submitting}
                onOrcaStart={() => void startOrca()}
                onEvidence={() => setSheet("evidence")}
                onTasks={() => setSheet("tasks")}
                context={communitySelection.context}
                images={communitySelection.images}
                onContext={(context) => updateCommunitySelection({ context })}
                onImages={(images) => updateCommunitySelection({ images })}
              />
            )}
          </div>
        </div>
      </div>

      {sheet === "prefs" && (
        <Modal
          domId="model-download-prefs"
          title="模型下载配置"
          iconClass="fas fa-sliders"
          onClose={() => setSheet(null)}
          bodyClass="model-download-sheet model-download-prefs"
          footer={
            <>
              <span />
              <button
                type="button"
                className="st-btn st-btn--primary model-download-prefs-done"
                onClick={() => setSheet(null)}
              >
                完成
              </button>
            </>
          }
        >
          <div className="model-download-form">
            <label>
              <span>下载源</span>
              <select
                className="form-control"
                value={prefs.source}
                onChange={(e) => savePrefs({ source: e.target.value as DownloadPrefs["source"] })}
              >
                <option value="auto">自动</option>
                <option value="huggingface">Hugging Face</option>
                <option value="modelscope">ModelScope（国内）</option>
              </select>
            </label>
            <label>
              <span>HF 镜像</span>
              <input
                type="text"
                className="form-control"
                placeholder="https://hf-mirror.com"
                value={prefs.hfEndpoint}
                onChange={(e) => savePrefs({ hfEndpoint: e.target.value })}
              />
            </label>
            <label>
              <span>后端</span>
              <select className="form-control" value={prefs.backend} onChange={(e) => savePrefs({ backend: e.target.value })}>
                <option value="">自动</option>
                <option value="cuda">CUDA</option>
                <option value="hip">HIP（AMD）</option>
                <option value="sycl">SYCL（Intel）</option>
              </select>
            </label>
            <label>
              <span>显卡</span>
              <select className="form-control" value={prefs.gpu} onChange={(e) => savePrefs({ gpu: e.target.value })}>
                <option value="">自动</option>
                {(host?.gpus ?? []).map((name, index) => (
                  <option key={`${name}-${index}`} value={String(index)}>
                    {index} · {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="model-download-form-wide">
              <span>下载目录</span>
              <div className="model-download-pick">
                <span className={`model-download-pick-path${prefs.dataDir ? "" : " is-empty"}`}>
                  {prefs.dataDir || `默认（${disk?.dataDirectory ?? "控制端数据目录"}）`}
                </span>
                <button
                  type="button"
                  className="st-btn st-btn--secondary st-btn--sm"
                  onClick={() => void pickDataDir()}
                >
                  选择文件夹…
                </button>
                {prefs.dataDir ? (
                  <button
                    type="button"
                    className="st-btn st-btn--secondary st-btn--sm"
                    onClick={() => savePrefs({ dataDir: "" })}
                  >
                    恢复默认
                  </button>
                ) : null}
              </div>
            </label>
          </div>
        </Modal>
      )}

      {sheet === "local" && (
        <Modal
          domId="model-download-local"
          title="使用已有模型（本地 GGUF 文件）"
          iconClass="fas fa-folder-open"
          onClose={() => setSheet(null)}
          bodyClass="model-download-sheet"
          footer={
            <div className="model-download-local-submit">
              <span className="model-download-local-note">
                检查 → 打包 → 生成配置，完成后在「我的模型」启用。原文件不会被移动或修改。
              </span>
              <button
                type="button"
                className="st-btn st-btn--primary"
                disabled={submitting || running || localBusy || !localDir.trim() || !localGroup}
                onClick={() => void useLocal()}
              >
                使用已有模型
              </button>
            </div>
          }
        >
          <p className="model-download-desc">
            选择已下载的 GGUF 文件夹或其中一个分片，确认量化版本后原地使用，不再重复下载。
          </p>

          <h4 className="model-download-sheet-title">模型文件</h4>
          <div className="model-download-pick">
            <span className={`model-download-pick-path${localDir ? "" : " is-empty"}`}>
              <i className="fas fa-folder" />
              <span className="model-download-pick-text">{localDir || "尚未选择"}</span>
              {localDir && (
                <button
                  type="button"
                  className="model-download-pick-refresh"
                  title="重新扫描这个目录"
                  disabled={localBusy}
                  onClick={() => void scanDir(localDir)}
                >
                  <i className={`fas fa-rotate${localBusy ? " fa-spin" : ""}`} />
                </button>
              )}
            </span>
            <button type="button" className="st-btn st-btn--secondary" onClick={() => void browseDir()}>
              选择文件夹…
            </button>
          </div>

          <h4 className="model-download-sheet-title">选择模型与量化版本</h4>
          {localGroup ? (
            <>
              <div className="model-download-local-card">
                <div className="model-download-local-card-head">
                  <b>{localGroup.base}</b>
                  <span>{localGroups.length} 个量化版本</span>
                </div>
                {localGroups.map((group) => (
                  <label
                    key={group.quant}
                    className={`model-download-local-row${group.quant === localGroup.quant ? " is-active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="model-download-local-quant"
                      checked={group.quant === localGroup.quant}
                      onChange={() => setLocalQuant(group.quant)}
                    />
                    <b>{group.quant}</b>
                    <span>
                      {fmtSize(group.bytes)}
                      {group.shards > 1 ? ` · ${group.shards} 个分片` : ""}
                    </span>
                    <em className={`model-download-local-state${group.family ? "" : " is-warn"}`}>
                      {group.family ? "可用 · 请确认" : "家族未知"}
                    </em>
                  </label>
                ))}
              </div>
              <p className="model-download-local-hint">
                安装器会按{" "}
                <code>
                  --family {localGroup.family ?? "?"} --model {localGroup.quant}
                </code>{" "}
                使用这个目录里的 {localGroup.quant} 文件（文件名不必与官方发布名一致）
              </p>
            </>
          ) : (
            <p className="model-download-empty">选择文件夹后，这里会列出目录里可用的量化版本。</p>
          )}

          <h4 className="model-download-sheet-title">上下文长度</h4>
          <select
            className="form-control model-download-local-context"
            value={localContext}
            disabled={!localGroup}
            onChange={(e) => setLocalContext(Number(e.target.value))}
          >
            {DOWNLOAD_CONTEXT_PRESETS.filter((preset) => !isExtendedContext(preset)).map((preset) => (
              <option key={preset} value={preset}>
                {formatContextTokens(preset)}
              </option>
            ))}
          </select>
          <p className="model-download-local-hint">图像支持默认关闭，可稍后在配置页开启。</p>

          <details
            className="model-download-local-fold"
            open={mtpOpen}
            onToggle={(event) => setMtpOpen(event.currentTarget.open)}
          >
            <summary>
              MTP 草稿层（可选） <span className={mtpCheck?.problems.length ? "is-bad" : ""}>{mtpState}</span>
            </summary>
            <p className="model-download-local-hint">
              已有 rt/experts.bin 时选择其文件夹，可省去约 5 GB 下载；不选则由安装器自动准备。
            </p>
            <div className="model-download-pick">
              <span className={`model-download-pick-path${mtpPath ? "" : " is-empty"}`}>
                <i className="fas fa-folder" />
                <span className="model-download-pick-text">
                  {mtpPath || "未选择，安装器会自动查找或下载"}
                </span>
                {mtpPath && (
                  <button
                    type="button"
                    className="model-download-pick-refresh"
                    title="清除"
                    onClick={() => {
                      setMtpPath("");
                      setMtpCheck(null);
                    }}
                  >
                    <i className="fas fa-xmark" />
                  </button>
                )}
              </span>
              <button type="button" className="st-btn st-btn--secondary" onClick={() => void pickMtp()}>
                选择 MTP 文件夹…
              </button>
            </div>
          </details>

          <h4 className="model-download-sheet-title">使用前检查</h4>
          <ul className="model-download-local-checks">
            {localGroup ? (
              <li>
                <i className="fas fa-circle" /> 磁盘 还需约{" "}
                {Math.max(4, Math.ceil(localGroup.bytes / 1e9 / 12))} GB（打包、MTP、运行环境）{" "}
                <code>{prefs.dataDir.trim() || disk?.dataDirectory || "控制端默认目录"}</code>
              </li>
            ) : (
              <li className="is-muted">
                <i className="fas fa-circle" /> 选择文件夹后显示磁盘需求
              </li>
            )}
          </ul>
        </Modal>
      )}
      {sheet === "tasks" && (
        <Modal
          domId="model-download-tasks"
          title="下载任务"
          iconClass="fas fa-download"
          onClose={() => setSheet(null)}
          bodyClass="model-download-sheet"
          footer={<small>下载在后台跑，关掉这个窗口不影响进度。</small>}
        >
          <div className="model-download-task-list">
            {error && <p className="model-download-error">{error}</p>}
            <TaskPanel task={downloadTaskView(snapshot)} onCancel={() => void cancel()} />
            <TaskPanel task={orcaTaskView(orca)} onCancel={() => void cancelOrca()} />
            {!snapshot && !orca && (
              <p className="model-download-empty">
                <i className="fas fa-inbox" /> 还没有下载任务。
              </p>
            )}
            <p className="model-download-desc">
              一次只跑一个下载；完成后回到「模型」页，在 Strata 那档点刷新就能看到新配置。
            </p>
          </div>
        </Modal>
      )}

      {sheet === "evidence" && (
        <Modal
          domId="model-download-evidence"
          title="资源预估与依据"
          iconClass="fas fa-circle-question"
          onClose={() => setSheet(null)}
          bodyClass="model-download-sheet"
          footer={null}
        >
          <ul className="model-download-assessment">
            <li>
              内存：参考占用取官网 MODELS.md「Pick by memory」的口径 —— <b>模型权重占的「显存 + 内存」合计</b>
              （qwen 2.00bpw 37.6、3.25bpw 39.2、4.25bpw 47.0、4.5bpw 54.8 GB）。本机
              {memoryGB ? ` 可用 ${host?.availableMemoryGb?.toFixed(2) ?? Math.round(memoryGB)} GiB` : " 内存未读到"}
              ，显存 {vramGB ? `${vramGB.toFixed(1)} GiB` : "未知"}，
              判定按「可用内存 + 显存」合计；安装器的内存门槛（含系统余量，qwen 起步版 48 GB）另算。
            </li>
            <li>
              磁盘：预检按「下载体积 × 2 + 6 GB」估算（分片与成品并存 + 打包余量），
              所以比下载大小看起来大不少。
            </li>
            <li>速度：取同类机型的实测区间，再按本机显存相对参考机型的大小上下取整，只用于比较不同量化。</li>
            <li>
              依据：{estimate.basis === "none" ? "这批量化还没有实测机型。" : basisLabel(estimate.basis)}
              {estimate.extrapolated ? "（含外推）" : ""}
            </li>
          </ul>
          <p className="model-download-desc">
            这些是估算，不是运行保证：长上下文、图像输入和并行请求都会额外吃内存与显存。
          </p>
        </Modal>
      )}
    </main>
  );
}

/** 每个家族挑一个贴切的图标（FontAwesome，与全站一致） */
function dsv41Icon(family: string): string {
  switch (family) {
    case "deepseek41":
      return "fa-brain";
    case "coder":
      return "fa-code";
    case "qwen36":
      return "fa-image";
    case "gyro":
      return "fa-microchip";
    case "unsloth":
      return "fa-layer-group";
    case "swift":
      return "fa-bolt";
    default:
      return "fa-cube";
  }
}

/** 任务面板的归一化视图：官方档、社区档、ORCA 三条流程共用一份渲染。 */
interface TaskView {
  running: boolean;
  ok: boolean | null;
  percent: number;
  detail: string;
  message: string;
  logTail: string[];
  /** 完成时显示的总量（如「66.80 GB」） */
  size?: string;
}

/** 安装器阶段的中文说法（与 `strata_download::consume` 写的 `phase` 对应）。 */
const PHASE_LABEL: Record<string, string> = {
  check: "检查环境",
  download: "下载分片",
  pack: "打包权重",
  engine: "准备引擎",
  config: "写入配置",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function downloadTaskView(snapshot: StrataDownloadSnapshot | null): TaskView | null {
  if (!snapshot) {
    return null;
  }
  return {
    running: snapshot.running,
    ok: snapshot.ok,
    percent: snapshot.percent,
    detail: [snapshot.family, snapshot.quant, PHASE_LABEL[snapshot.phase] ?? snapshot.phase]
      .filter(Boolean)
      .join(" · "),
    message: snapshot.message,
    logTail: snapshot.logTail,
    size: snapshot.totalBytes > 0 ? fmtSize(snapshot.totalBytes) : undefined,
  };
}

function orcaTaskView(snapshot: StrataOrcaSnapshot | null): TaskView | null {
  if (!snapshot) {
    return null;
  }
  const phase =
    snapshot.phase === "download"
      ? "下载分片"
      : snapshot.phase === "pack"
        ? "打包"
        : snapshot.phase === "config"
          ? "写配置"
          : snapshot.phase;
  return {
    running: snapshot.running,
    ok: snapshot.ok,
    percent: snapshot.percent,
    detail: `ORCA · IQ3_XXS · ${phase}`,
    message: snapshot.message,
    logTail: snapshot.logTail,
    size: snapshot.totalBytes > 0 ? fmtSize(snapshot.totalBytes) : undefined,
  };
}

/** 任务面板：官方档、社区档与 ORCA 共用（进度、输出、取消）。 */
function TaskPanel({ task, onCancel }: { task: TaskView | null; onCancel: () => void }) {
  if (!task) {
    return null;
  }
  const state = task.running ? "running" : task.ok ? "done" : "failed";
  const label = task.running ? "正在下载" : task.ok ? "已完成" : "已结束";
  const icon = task.running ? "fa-download" : task.ok ? "fa-circle-check" : "fa-triangle-exclamation";
  const percent = Math.max(0, Math.min(100, Math.round(task.percent)));
  return (
    <div className={`model-download-task is-${state}`}>
      <div className="model-download-task-head">
        <span className="model-download-task-icon">
          <i className={`fas ${icon}`} />
        </span>
        <div className="model-download-task-copy">
          <b>{label}</b>
          <small>{task.detail}</small>
        </div>
        {task.running ? (
          <span className="model-download-task-percent">{percent}%</span>
        ) : task.size ? (
          <span className="model-download-task-percent is-size">{task.size}</span>
        ) : null}
        {task.running && onCancel && (
          <button type="button" className="st-btn st-btn--secondary st-btn--sm" onClick={onCancel}>
            <i className="fas fa-stop" /> 取消
          </button>
        )}
      </div>
      <progress className="model-download-progress" value={percent} max={100} />
      {task.message && <p className="model-download-task-message">{task.message}</p>}
      {task.logTail.length > 0 && (
        <details className="model-download-task-log">
          <summary>
            <i className="fas fa-terminal" /> 安装器输出 · {task.logTail.length} 行
          </summary>
          <pre className="model-download-log">{task.logTail.slice(-60).join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

/** 社区档的详情：量化、风险、资源评估与提交（社区条目同样交给官方安装器）。 */
function CommunityPane({
  model,
  quant,
  onQuant,
  disk,
  hardware,
  memoryGB,
  vramGB,
  submitting,
  running,
  error,
  snapshot,
  onStart,
  taskRef,
  orcaProbe,
  orca,
  orcaSubmitting,
  onOrcaStart,
  onEvidence,
  onTasks,
  context,
  images,
  onContext,
  onImages,
}: {
  model: StrataCommunityModel | undefined;
  quant: string;
  onQuant: (quant: string) => void;
  disk: StrataDownloadDisk | null;
  hardware: ReturnType<typeof hardwareOf>;
  memoryGB: number | null;
  vramGB: number | null;
  submitting: boolean;
  running: boolean;
  error: string | null;
  /** 官方下载任务的快照（社区条目也走同一条安装器） */
  snapshot: StrataDownloadSnapshot | null;
  onStart: () => void;
  taskRef: RefObject<HTMLDivElement | null>;
  orcaProbe: StrataOrcaProbe | null;
  orca: StrataOrcaSnapshot | null;
  orcaSubmitting: boolean;
  onOrcaStart: () => void;
  onEvidence: () => void;
  /** 打开「下载任务」弹窗（社区档的进度条旁边那颗按钮） */
  onTasks: () => void;
  context: number;
  images: boolean;
  onContext: (context: number) => void;
  onImages: (images: boolean) => void;
}) {
  const [presetOpen, setPresetOpen] = useState(true);

  if (!model) {
    return (
      <div className="model-download-detail-body">
        <p className="model-download-empty">没有可用的社区模型</p>
      </div>
    );
  }

  const info = model.quantInfo[quant];
  // 与官方页同口径：参考值是「显存 + 内存」，判定预算也把两者加起来
  const budgetGB = memoryGB != null ? memoryGB + (vramGB ?? 0) : null;
  const rowFit = fitOf(info?.ramGb ?? 0, budgetGB, null);
  const isOrca = model.family === "orca";
  const supported = setupFamilyOf(model.family);
  const estimate = estimatePerformance(model.family, quant, hardware);
  const axisMax = Math.max(
    usableMemoryGb(memoryGB, vramGB) ?? 0,
    ...model.quants.map((name) => model.quantInfo[name]?.ramGb ?? 0),
    32,
  );

  return (
    <>
      <div className="model-download-detail-body">
        <div className="model-download-detail-heading">
          <span className="model-download-family">
            社区 · {kindLabel(model.kind)}
          </span>
          <h3>{model.name}</h3>
          <a href={`https://huggingface.co/${model.repo}`} target="_blank" rel="noreferrer">
            仓库 <i className="fas fa-arrow-up-right-from-square" />
          </a>
        </div>
        <div className="model-download-model-meta">
          <em className="model-download-badge is-community">社区 · 无审查</em>
          <span>{model.repo}</span>
          <em className="model-download-badge">{model.revision.slice(0, 8)}</em>
        </div>
        <p className="model-download-desc">
          {model.images ? "支持图像输入" : "仅文本"}
          {model.mmproj ? ` · ${model.mmproj}` : ""}
          {model.downloads !== null ? ` · ${model.downloads.toLocaleString()} 次下载` : ""}
        </p>

        <div className="model-download-risks">
          {model.risks.map((risk) => (
            <span key={risk} className="model-download-risk">
              {riskLabel(risk)}
            </span>
          ))}
        </div>

        {isOrca ? (
          <OrcaPanel probe={orcaProbe} />
        ) : (
          <>
            <fieldset className="model-download-variants">
              <legend>1. 选择量化版本</legend>
              <div className="model-download-variant-head">
                <span>量化</span>
                <span>下载大小</span>
                <span>参考占用（显存 + 内存）</span>
                <span>本机 {memoryGB ? Math.round(memoryGB) : "—"} GB</span>
                <span>速度（估算）</span>
              </div>
              {model.quants.map((name) => {
                const entry = model.quantInfo[name];
                const rowRam = entry?.ramGb ?? 0;
                const fit = fitOf(rowRam, budgetGB, null);
                // 传真实 family：兜底成 "qwen" 会在这里显示一排速度、而底部汇总按「无实测数据」处理，
                // 两处自相矛盾（审查发现）。未知 family 由 estimatePerformance 返回 none，行内显示「—」
                const rowEstimate = estimatePerformance(model.family, name, hardware);
                const rowSpeed = formatRange(rowEstimate.decode, rowEstimate.bound);
                const rowFirst = formatRange(rowEstimate.ttft4k);
                return (
                  <label key={name} className="model-download-variant">
                    <span className="model-download-variant-name">
                      <input
                        type="radio"
                        name="model-download-community-quant"
                        checked={quant === name}
                        onChange={() => onQuant(name)}
                      />
                      <b>{name}</b>
                    </span>
                    <span>{entry?.downloadGb ?? "—"} GB</span>
                    <span>{entry?.ramGb ?? "—"} GB</span>
                    <span className="model-download-axis">
                      <progress value={entry?.ramGb ?? 0} max={axisMax} />
                      <small className={`model-download-fit is-${fit}`}>{FIT_LABEL[fit]}</small>
                    </span>
                    <span className="model-download-est">
                      {rowSpeed ? (
                        <span className="model-download-est-main">
                          <b>{rowSpeed}</b>
                          <small> tok/s</small>
                        </span>
                      ) : (
                        <span>—</span>
                      )}
                      {rowFirst ? <em className="model-download-est-badge">估算 · 首字 {rowFirst} s</em> : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p className="model-download-basis">
              {estimate.basis === "none" ? "没有对应的实测机型，速度暂时给不出。" : `参考 ${basisLabel(estimate.basis)}`}
            </p>

            <section className="model-download-preset-card">
              <div className="model-download-preset-head">
                <b>
                  <i className="fas fa-sliders" /> 启动预设
                </b>
                <span className="model-download-preset-summary">
                  {formatContextTokens(context)} 上下文 · {images ? "图像开启" : "图像关闭"}
                </span>
                <button
                  type="button"
                  className="model-download-preset-toggle"
                  title={presetOpen ? "收起" : "展开"}
                  onClick={() => setPresetOpen((open) => !open)}
                >
                  <i className={`fas fa-chevron-${presetOpen ? "up" : "down"}`} />
                </button>
              </div>
              {presetOpen && (
                <div className="model-download-preset-body">
                <div className="model-download-context-presets">
                  {/* 与官方条目那套一致：外观照「测试计划」的档位标签，尺寸不变（用户 m00888） */}
                  {DOWNLOAD_CONTEXT_PRESETS.filter((preset) => !isExtendedContext(preset)).map((preset) => {
                    const on = context === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        className={on ? "is-active" : ""}
                        onClick={() => onContext(preset)}
                      >
                        <span className="st-tier__box">{on && <i className="fas fa-check" />}</span>
                        {formatContextTokens(preset)}
                      </button>
                    );
                  })}
                </div>
                <div className="model-download-preset-row">
                  <label className="model-download-context-field">
                    <span>上下文长度</span>
                    <input
                      type="number"
                      className="form-control"
                      min={CONTEXT_MIN}
                      max={CONTEXT_MAX}
                      value={context}
                      onChange={(e) => onContext(Number(e.target.value) || CONTEXT_MIN)}
                    />
                  </label>
                  <label className="model-download-image-toggle">
                    <span>启用图像支持</span>
                    <input
                      type="checkbox"
                      className="switch-input"
                      checked={images}
                      disabled={!model.images}
                      onChange={(e) => onImages(e.target.checked)}
                    />
                  </label>
                </div>

              </div>
              )}
            </section>

            <section className="model-download-assess-card">
              <div className="model-download-assess-head">
                <b>当前选择的资源预估</b>
                <span className={`model-download-fit is-${rowFit}`}>{FIT_LABEL[rowFit]}</span>
                <button type="button" className="model-download-assess-help" onClick={onEvidence}>
                  <i className="fas fa-circle-question" /> 查看分项与依据
                </button>
              </div>
              <div className="model-download-assess-cols">
                <div>
                  <span>本机可用 RAM</span>
                  <b>{memoryGB ? `${Math.round(memoryGB)} GB` : "—"}</b>
                </div>
                <div>
                  <span>参考占用（显存 + 内存）</span>
                  <b>{info?.ramGb ?? "—"} GB</b>
                </div>
                <div>
                  <span>磁盘空间</span>
                  <b className={disk?.status === "ready" ? "is-ok" : "is-bad"}>
                    {disk?.status === "ready" ? "充足" : disk?.status === "insufficient" ? "不足" : "未核验"}
                  </b>
                </div>
              </div>
              <p className="model-download-assess-note">
                下载大小按仓库里各分片体积求和；参考占用取官方同一量化的「显存 + 内存」值（取不到时按「体积 + 10 GB」估算）。
              </p>
            </section>
          </>
        )}
      </div>

      <footer className="model-download-submit" ref={taskRef}>
        {error && <p className="model-download-error">{error}</p>}
        {isOrca
          ? orca?.running && (
              <div className="model-download-inline">
                <progress
                  className="model-download-progress"
                  value={Math.round(orca.percent)}
                  max={100}
                />
                <span>
                  ORCA · {Math.round(orca.percent)}%
                </span>
                <button
                  type="button"
                  className="st-btn st-btn--secondary st-btn--sm"
                  onClick={onTasks}
                >
                  <i className="fas fa-list-check" /> 任务
                </button>
              </div>
            )
          : running &&
            snapshot && (
              <div className="model-download-inline">
                <progress
                  className="model-download-progress"
                  value={Math.round(snapshot.percent)}
                  max={100}
                />
                <span>
                  {PHASE_LABEL[snapshot.phase] ?? snapshot.phase} ·{" "}
                  {Math.round(snapshot.percent)}%
                </span>
                <button
                  type="button"
                  className="st-btn st-btn--secondary st-btn--sm"
                  onClick={onTasks}
                >
                  <i className="fas fa-list-check" /> 任务
                </button>
              </div>
            )}
        <div className="model-download-submit-row">
          {isOrca ? (
            <>
              <span>
                ORCA · IQ3_XXS · 32K · 专家 arena 需约 {orcaProbe?.arenaGib ?? 49.8} GiB 内存
              </span>
              <button
                type="button"
                className="st-btn st-btn--primary"
                disabled={!orcaProbe?.available || orcaSubmitting || Boolean(orca?.running)}
                onClick={onOrcaStart}
              >
                {orcaSubmitting
                  ? "正在开始…"
                  : orca?.running
                    ? "正在导入…"
                    : orcaProbe?.available
                      ? `开始 ORCA 导入 · ${fmtSize(orcaProbe.downloadBytes)}`
                      : "环境不全"}
              </button>
            </>
          ) : (
            <>
              <span>
                已选择 {model.name} · {quant || "—"} · {formatContextTokens(context)}
              </span>
              <button
                type="button"
                className="st-btn st-btn--primary"
                disabled={submitting || running || !supported}
                onClick={onStart}
              >
                {submitting ? "正在检查并提交…" : supported ? `下载并准备 · ${info?.downloadGb ?? "?"} GB` : "需用官方安装器"}
              </button>
            </>
          )}
        </div>
        <small>
          {isOrca
            ? "分片下载 → 控制端 iq_pack 打包 → 写 strata-orca-iq3_xxs.json，完成后在「模型」页手动启用。"
            : supported
              ? "下载 → 打包 → 生成配置，完成后在「模型」页手动启用。"
              : "这条模型只能由官方安装器导入（见上方说明）。"}
        </small>
      </footer>
    </>
  );
}

/** ORCA 导入面板：先把「能不能跑」摆出来，再让用户决定。 */
function OrcaPanel({ probe }: { probe: StrataOrcaProbe | null }) {
  if (!probe) {
    return <p className="model-download-desc">正在检查 ORCA 环境…</p>;
  }
  return (
    <div className="model-download-orca">
      {probe.problems.length > 0 && (
        <p className="model-download-blocked">暂时不能导入：{probe.problems.join("；")}</p>
      )}
      <p className="model-download-desc">
        这条走 ORCA 的文本链路：两个 IQ3_XXS 分片（合计 {fmtSize(probe.downloadBytes)}）下好后，用控制端的{" "}
        <code>tools/iq_pack.py --compat-bf16</code> 打成 pack，再写一份配置。
      </p>
      <ul className="model-download-assessment">
        <li>
          分片目录：<code>{probe.ggufDir}</code>（{probe.shardsReady ? "已齐，跳过下载" : "待下载"}）
        </li>
        <li>
          pack 目录：<code>{probe.packDir}</code>（{probe.packReady ? "已存在" : "待生成"}）
        </li>
        <li>
          配置：<code>{probe.configPath}</code>
        </li>
        <li>
          磁盘：可用 {probe.availableBytes !== null ? fmtSize(probe.availableBytes) : "—"}，本次需要约{" "}
          {fmtSize(probe.downloadBytes)}
        </li>
        <li>内存：专家 arena 约 {probe.arenaGib} GiB 常驻</li>
        <li>
          <a
            href="https://github.com/Niko1221/Strata/blob/main/docs/ORCA.md"
            target="_blank"
            rel="noreferrer"
          >
            ORCA 说明 <i className="fas fa-arrow-up-right-from-square" />
          </a>
        </li>
      </ul>
    </div>
  );
}
