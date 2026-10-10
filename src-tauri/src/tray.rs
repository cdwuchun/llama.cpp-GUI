//! 托盘图标、菜单与「关闭到托盘」（P6）。
//!
//! 设计取舍：托盘**不直接调用** `router_start`/`router_stop` 这两条命令 —— 它们需要
//! `State<'_, AppState>`，在托盘回调里 spawn 出来的 async 任务中，`State` 借用
//! `AppHandle` 会与「把 AppHandle 移进任务」形成自引用借用，编译器不允许。
//! 因此托盘把命令**发给前端**（`tray://command`），由前端 store 里已有的
//! `startRouter`/`stopRouter` 执行：窗口只是被 `hide` 而不是销毁，webview 一直活着，
//! 于是托盘按钮与界面按钮走完全相同的代码路径、错误提示和状态刷新。

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

/// 托盘 → 前端的命令事件，payload 为 `start-router` / `stop-router`。
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
    start.set_enabled(false)?;
    stop.set_enabled(false)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(false, 0))
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
            let _ = app.emit(COMMAND_EVENT, "start-router");
        }
        MENU_STOP => {
            let _ = app.emit(COMMAND_EVENT, "stop-router");
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

/// 托盘 tooltip：把 router 状态直接写在悬停提示里，不必打开窗口。
fn tooltip(running: bool, port: u16) -> String {
    if running {
        format!("llama.cpp GUI — router 运行中（127.0.0.1:{port}）")
    } else {
        "llama.cpp GUI — router 未运行".to_string()
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
    let router_running = running || router_slot_busy(app);
    let strata_running = strata_slot_busy(app);
    sync_menu_state(app, router_running, strata_running);
}

/// 按进程槽判断 router 是否在跑。
///
/// 用进程槽而不是 `running` 参数：`strata_start` 之类的路径不一定走 `sync_tooltip`，
/// 托盘菜单的可用性只取决于「有没有进程在跑」，直接读槽最不容易和真实状态脱节。
fn router_slot_busy<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppState>()
        .map(|state| state.router_slot.lock().unwrap_or_else(|e| e.into_inner()).is_some())
        .unwrap_or(false)
}

fn strata_slot_busy<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppState>()
        .map(|state| state.strata_slot.lock().unwrap_or_else(|e| e.into_inner()).is_some())
        .unwrap_or(false)
}

/// 正在跑的进程不允许再点一次「启动服务」（同理，没跑时「停止服务」是死键）。
pub fn sync_menu_state<R: Runtime>(app: &AppHandle<R>, router_running: bool, strata_running: bool) {
    let Some(menu) = app.try_state::<TrayMenu<R>>() else {
        // 托盘没建起来（`tray::init` 失败）时这里本来就是空转，不算错误。
        return;
    };
    // 任一进程在跑都不能再启动：router 与 Strata 抢同一批 GPU 显存。
    if let Err(err) = menu.start.set_enabled(!(router_running || strata_running)) {
        eprintln!("[tray] 更新「启动服务」可用性失败: {err}");
    }
    if let Err(err) = menu.stop.set_enabled(router_running || strata_running) {
        eprintln!("[tray] 更新「停止服务」可用性失败: {err}");
    }
}

/// 退出：先停 router（子实例会跟着退出），再走正常退出流程。
fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<AppState>() {
        // 停 router。
        let _ = crate::router::stop_router(&state.router_slot);

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
    }
    app.exit(0);
}
