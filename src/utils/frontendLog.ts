/** 前端错误上报（放在独立的纯 TS 模块里，避免和组件混在一个文件里破坏 Fast Refresh）。 */

import { invoke } from "@tauri-apps/api/core";

/** 把前端错误送到后端日志（可在「日志」页的 frontend 来源里看到）。 */
export function reportFrontendError(level: string, message: string): void {
  void invoke("frontend_log", { level, message }).catch(() => {
    /* 上报失败不影响界面 */
  });
  // 同时留在控制台，便于 devtools 查看
  console.error(`[${level}] ${message}`);
}
