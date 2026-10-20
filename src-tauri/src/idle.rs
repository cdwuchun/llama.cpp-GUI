//! 空闲释放模型：空闲够久就把子实例整体停掉，显存归零。
//!
//! 不走 llama.cpp 的 `--sleep-idle-seconds`：那只是进入 sleep，权重与 KV 放掉，但子进程还在、
//! CUDA context 仍占着显存（实机实测 610 MB 的 Q8 模型：加载 10158 MB → 休眠 156 MB → 卸载 0 MB，
//! 用户看到的"还剩 0.2 GB"就是这一段）。也不等 router 时代的 `sleeping` 状态上报（前门合成的
//! `/models` 只报 loaded / loading / unloaded，那条链路本来就是断的，用户 m06664）。
//!
//! 前门自己就记着每个模型最后一次被使用的时间（`ModelRuntime::last_used_ms`，转发成功时 `touch`），
//! 这里据此判定：**状态是 Ready、没有请求正在转发、且空闲超过设置里的秒数**就 `Scheduler::stop`。
//! 下一次请求前门会按需把它重新拉起来（`scheduler::ensure_ready`）。
//!
//! 线程**常驻**（随程序启动，跟前门在不在无关），每一轮都重新读设置：
//! 所以「空闲释放模型（秒）」改完保存就生效，不用重启前门，也不用重启程序（用户 m06652）。
//! 设为 `-1` / `0`（`<= 0`）表示关闭。

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::logs::LogHub;
use crate::scheduler::{self, ModelState};
use crate::state::AppState;

/// 扫描间隔：空闲释放精确到秒级就够，2 s 一轮既及时又不费 CPU。
const TICK: Duration = Duration::from_secs(2);

/// 常驻一次（见模块头）。重复调用会多挂一个线程，调用点只应有一个。
pub fn spawn_idle_unloader(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(TICK);

        let state = app.state::<AppState>();
        // 每轮重读：设置改完保存即生效。
        let seconds = state.settings.get().sleep_idle_seconds;
        if seconds <= 0 {
            continue; // 关闭
        }
        let idle_ms = (seconds as u64).saturating_mul(1000);
        let now = crate::logs::now_ms();

        // 先在锁里挑人（只读），挑完放锁再动 —— 停进程要在锁内做，但判定不需要一直持锁。
        let victims = {
            let sched = scheduler::lock_sched(&state);
            sched.table().idle_ids(now, idle_ms)
        };

        for id in victims {
            // 挑完之后又可能被用起来：动手前再确认一次。
            let skip = {
                let sched = scheduler::lock_sched(&state);
                let table = sched.table();
                table.state_of(&id) != ModelState::Ready
                    || table.runtime(&id).map(|item| item.is_busy()).unwrap_or(true)
            };
            if skip {
                continue;
            }
            let hub: Arc<LogHub> = Arc::clone(&state.logs);
            scheduler::lock_sched(&state).stop(&id, &hub);
            let line = state.logs.push(
                "system",
                format!("[gui] 模型 {id} 空闲超过 {seconds} 秒，已卸载实例释放显存"),
            );
            let _ = app.emit("logs://lines", vec![line]);
        }
    });
}
