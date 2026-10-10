// 发布构建时不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    llamacpp_gui_lib::run()
}
