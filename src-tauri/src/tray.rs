//! 托盘图标、菜单与「关闭到托盘」（P6）。
//!
//! 设计取舍：托盘**不直接调用** `strata_proxy_start`/`strata_proxy_stop` 这两条命令 ——
//! 它们需要 `State<'_, AppState>`，在托盘回调里 spawn 出来的 async 任务中，`State` 借用
//! `AppHandle` 会与「把 AppHandle 移进任务」形成自引用借用，编译器不允许。
//! 因此托盘把命令**发给前端**（`tray://command`），由前端 store 里已有的
//! `startStrataProxy`/`stopStrataProxy` 执行：窗口只是被 `hide` 而不是销毁，webview
//! 一直活着，于是托盘按钮与界面按钮走完全相同的代码路径、错误提示和状态刷新。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

use crate::state::AppState;

/// 托盘图标 id（同时用于 `app.tray_by_id`）。
pub const TRAY_ID: &str = "main";

const MENU_SHOW: &str = "tray_show";
const MENU_START: &str = "tray_start";
const MENU_STOP: &str = "tray_stop";
const MENU_QUIT: &str = "tray_quit";

/// 托盘 → 前端的命令事件，payload 为 `start-service` / `stop-service`。
pub const COMMAND_EVENT: &str = "tray://command";

/// 创建托盘图标（图标复用窗口图标，不额外引入图片解码 feature）。
pub fn init<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    // 这里只是建初值，真正的可用性由 `sync_menu_state` 按进程槽刷：
    // 刚建好时两个服务都没跑，先按「不能启动、也不能停止」显示。
    let show = MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, MENU_START, "启动服务", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, MENU_STOP, "停止服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    // 初值按**当前实际状态**给：前门是随程序启动的，托盘创建时它多半已经在跑，
    // 写死「未启动」会让悬停提示与菜单可用性一开始就是错的。
    let (service_running, service_port) = app
        .try_state::<crate::state::AppState>()
        .and_then(|state| crate::strata_proxy::running_port(&state))
        .map(|port| (true, port))
        .unwrap_or((false, crate::strata_proxy::DEFAULT_PORT));
    start.set_enabled(!service_running)?;
    stop.set_enabled(service_running)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(service_running, service_port))
        .menu(&menu)
        // 左键留给「显示主窗口」，菜单只走右键
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // 托盘用**小尺寸专用版**图标：主图标是「三层 + 细闪电」，缩到托盘实际尺寸
    // （150% 缩放时约 24px）后层间距不到 1px、糊成一片。
    // 这版是专为 16/24/32px 重画的（两层 + 粗闪电），数据由
    // `scripts/make-tray-icon.mjs` 生成；同时避免依赖 PNG 解码 feature。
    builder = builder.icon(tauri::image::Image::new_owned(
        crate::tray_icon::TRAY_ICON_RGBA.to_vec(),
        crate::tray_icon::TRAY_ICON_SIZE,
        crate::tray_icon::TRAY_ICON_SIZE,
    ));
    builder.build(app)?;
    // 把「启动服务 / 停止服务」两个菜单项存进托管状态，供 `sync_menu_state` 改可用性。
    app.manage(TrayMenu { start, stop });
    Ok(())
}

/// 需要按运行状态改可用性的托盘菜单项。
///
/// Tauri 2 的 `MenuItem` 本身可以克隆（内部是 `Arc`），所以这里直接持有句柄，
/// 不必反查 `app.menu()`：托盘菜单的主菜单挂在托盘上、不在窗口菜单栏里，
/// 按 id 反查要绕开 `Menu`/`Submenu`/`MenuItemKind` 三层类型，代价更大。
pub struct TrayMenu<R: Runtime> {
    pub start: MenuItem<R>,
    pub stop: MenuItem<R>,
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_SHOW => show_main(app),
        MENU_START => {
            // 启动过程有日志与状态变化，把窗口叫出来让用户看到反馈
            show_main(app);
            let _ = app.emit(COMMAND_EVENT, "start-service");
        }
        MENU_STOP => {
            let _ = app.emit(COMMAND_EVENT, "stop-service");
        }
        MENU_QUIT => quit(app),
        _ => {}
    }
}

/// 显示并聚焦主窗口（关闭时是 hide，所以要 unminimize + set_focus 才能到前台）。
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 托盘 tooltip：把服务状态直接写在悬停提示里，不必打开窗口。
///
/// 「服务」= 前门（:9090）：router 退役后不再有单独的 router 进程，
/// 对外只有这一个入口，所以这里报的是前门的监听状态。
fn tooltip(running: bool, port: u16) -> String {
    if running {
        format!("llama.cpp GUI — 服务运行中（前门 127.0.0.1:{port}）")
    } else {
        "llama.cpp GUI — 服务未启动".to_string()
    }
}

/// 跟随 router 状态更新托盘提示。
///
/// 菜单项可用性也在这里一起刷 —— 调用点已经拿了 `State<'_, AppState>`，
/// 再让调用方多刷一次菜单没有意义，而且容易漏。
pub fn sync_tooltip<R: Runtime>(app: &AppHandle<R>, running: bool, port: u16) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip(running, port)));
    }
    let strata_running = strata_slot_busy(app);
    sync_menu_state(app, running, strata_running);
}

/// 「Strata 在跑」：引擎槽位里有进程，**或**前门代理在监听。
///
/// 前门开着就算在跑（它占着 9090 这个对外端口），只看引擎槽位会让
/// "前门已开、模型还没加载"的状态被当成未运行。
fn strata_slot_busy<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppState>()
        .map(|state| crate::strata_busy(&state))
        .unwrap_or(false)
}

/// 正在跑的进程不允许再点一次「启动服务」（同理，没跑时「停止服务」是死键）。
///
/// `service_running` = 前门（统一入口 :9090）在跑。router 退役后没有第二个
/// 「服务」进程了，前门就是那个常驻的入口。
pub fn sync_menu_state<R: Runtime>(app: &AppHandle<R>, service_running: bool, strata_running: bool) {
    let Some(menu) = app.try_state::<TrayMenu<R>>() else {
        // 托盘没建起来（`tray::init` 失败）时这里本来就是空转，不算错误。
        return;
    };
    // 任一在跑都不能再启动：前门与 Strata 抢同一批 GPU 显存。
    if let Err(err) = menu.start.set_enabled(!(service_running || strata_running)) {
        eprintln!("[tray] 更新「启动服务」可用性失败: {err}");
    }
    if let Err(err) = menu.stop.set_enabled(service_running || strata_running) {
        eprintln!("[tray] 更新「停止服务」可用性失败: {err}");
    }
}

/// 退出：先停 Strata 引擎与前门拉起的子实例（都占显存），再走正常退出流程。
fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<AppState>() {
        // Strata 必须在这里直接停，不能只指望 `RunEvent::Exit` 兜底：
        // `AppHandle::exit` 正常会投递 `RunEvent::Exit`，但 `request_exit` 失败时
        // tauri 2.11.5 会退化成 `std::process::exit`（src/app.rs:573-580），
        // 直接跳过该事件 —— 恰恰是退出异常这种最需要清理的场景反而不会清理，
        // 而 Strata 的引擎子进程占着显存，留活口就是显存泄漏。
        // `stop_strata` 返回 `None` 有两种含义：slot 本来就空（无事发生），
        // 以及 take 到了进程 —— 所以先自己看一眼有没有活口再决定要不要报警。
        let had_process = state
            .strata_slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        if had_process && crate::strata::stop_strata(&state.strata_slot).is_none() {
            eprintln!("[tray] 退出时停止 Strata 失败：slot 已被清空但进程可能仍在");
        }
        // 前门代理也要摘掉：它的监听线程是 GUI 进程内的，句柄不 drop 就走不到释放
        // （虽然进程退出会一起带走，但这里显式关掉，退出路径才对得上）。
        crate::strata_proxy::shutdown(&state);
        // 前门拉起的 llama.cpp 子实例同样占显存，同样不能指望 `RunEvent::Exit` 兜底。
        let stopped = state
            .scheduler
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stop_all(&state.logs);
        if !stopped.is_empty() {
            eprintln!("[tray] 退出时已停止 llama.cpp 子实例：{}", stopped.join("、"));
        }
    }
    app.exit(0);
}
