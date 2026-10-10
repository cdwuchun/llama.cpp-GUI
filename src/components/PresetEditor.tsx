import { useRef, useState } from "react";

import { useApp } from "../store";
import { Modal } from "./Sheet";

/**
 * 原始 preset 编辑（`presets.ini` 整文件）。
 *
 * 为什么保留这条通路：参数表只覆盖 llama.cpp 的**模型段参数**，而 preset 文件里还有
 * * 全局默认段 `[*]`（所有模型共用，可被模型段覆盖）
 * * 应用不认识的手写键与注释
 * 直接编辑全文是这些内容的唯一入口，也是参数表解释不了某个键时的兜底。
 *
 * 保存后由 store 调 `/models?reload=1`，改 `[*]` 段无需重启 router 即可生效
 * （实测：新段立即出现为 unloaded，已加载模型保持不变）。
 */
export function PresetEditor({ onClose }: { onClose: () => void }) {
  const presetText = useApp((s) => s.presetText);
  const presetPath = useApp((s) => s.presetPath);
  const busy = useApp((s) => s.busy);
  const writePreset = useApp((s) => s.writePreset);

  /**
   * 打开时的快照（可变 ref：重新载入 / 保存后要挪基线）。
   *
   * dirty 必须问「**用户**改过输入框没有」，而不是「和实时值是否不同」——
   * `presetText` 是 store 里的实时值，后台任何一次刷新（`/models?reload=1`、
   * 另一个页签写盘、外部编辑器改文件后前端重读）都会让它变，于是保存按钮自己
   * 亮起来；用户顺手一点，就用这份**打开时的旧全文**覆盖了刚写进去的内容，
   * 期间新增的段全没了。
   */
  const initial = useRef(presetText);
  const [text, setText] = useState(presetText);

  /** 用户自己改过 */
  const edited = text !== initial.current;
  /** 用户没动，但文件被后台改了（或保存后 store 里换了新内容） */
  const externallyChanged = !edited && presetText !== initial.current;

  const reload = () => {
    initial.current = presetText;
    setText(presetText);
  };

  const save = async () => {
    await writePreset(text);
    onClose();
  };

  return (
    <Modal
      domId="presetEditorModal"
      title="编辑 presets.ini"
      icon={null}
      onClose={onClose}
      /* 整份文件都在一个 textarea 里，Esc 一下就全没了：改过就问一句。
         用原生 confirm —— 本仓没有 UI 库，BenchPanel 删记录也是这么做的
         （Tauri 的 WebView2 里 window.confirm 可用）。 */
      confirmClose={() => !edited || confirm("presets.ini 的修改还没保存，确定关闭吗？")}
      bodyClass="preset-editor"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !edited}>
            <i className="fas fa-save" /> 保存并重载
          </button>
        </>
      }
    >
      <div className="notice" style={{ marginTop: 0 }}>
        <i className="fas fa-circle-info" style={{ marginTop: 2 }} />
        <div>
          <code>[*]</code> 段是所有模型共用的默认值，模型段里的同名键会覆盖它。
          <code>port</code> / <code>host</code> / <code>alias</code> / <code>hf-repo</code>
          由 router 掌管，写进来会被忽略或覆盖。
        </div>
      </div>

      {/* 文件在弹窗打开后被后台换掉了：既不能静默覆盖，也不能让「保存」自己亮起来 */}
      {externallyChanged && (
        <div className="notice" style={{ marginTop: "0.5rem" }}>
          <i className="fas fa-rotate" style={{ marginTop: 2 }} />
          <div>
            preset 文件在打开期间被后台更新过（内容与打开时不同），这里显示的是**打开时的快照**。
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: 8, padding: "0.15rem 0.6rem", fontSize: "0.8rem" }}
              onClick={reload}
            >
              载入最新内容
            </button>
          </div>
        </div>
      )}

      <div className="form-text mono" style={{ marginTop: 0, marginBottom: "0.5rem" }}>
        {presetPath}
      </div>

      <textarea
        className="form-control mono"
        style={{ minHeight: "22rem", whiteSpace: "pre", resize: "vertical" }}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Modal>
  );
}
