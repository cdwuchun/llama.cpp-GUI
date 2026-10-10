; ---------------------------------------------------------------
; 卸载时的「用户数据」选项
;
; 便携模式下配置（settings.json / presets.ini / 压测记录）与 webview 数据
; （localStorage、缓存）都躺在安装目录里。Tauri 的卸载段只 Delete 它自己装进去的
; 文件、然后 RMDir（仅删空目录），也就是说用户数据默认会**留下**。这里补一个
; 明确的询问：删掉，还是原样保留（重装到同一目录即可继续用）。
;
; 询问放在 PREUNINSTALL —— 那时还能弹窗；
; 删除放在 POSTUNINSTALL —— 模板在那之后才 CheckIfAppIsRunning 并等应用退出，
; 否则应用占着 EBWebView 里的文件，删不干净。
;
; **覆盖安装必须不问也不删**：安装器发现已装版本时会以 `/UPDATE` 参数把旧卸载器
; 偷偷调起来（模板 installer.nsi 的 `StrCpy $R1 "$R1 /UPDATE"`），用户点的是
; 「安装新版本」，这时若弹出「是否同时删除用户数据」，误点「是」就会把设置、
; presets、压测记录、runtime（用户自己下载/编译的 llama.cpp，可达几十 GB）全带走。
; 模板自己的 app-data 清理正是用 `$UpdateMode <> 1` 守卫的，这里必须照做。
;
; 这个文件被 installer.nsi 用 `!include` 插在 `Unicode true` 之后（模板第 36 行附近），
; 所以 UTF-8 中文没问题（打包器用 makensis -INPUTCHARSET UTF8）。
; ---------------------------------------------------------------

; MUI2 已经 include 过，这里再写一次是为了不依赖模板顺序（LogicLib 自带 include guard）
!include "LogicLib.nsh"

Var LLAMACPP_PURGE_DATA

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $LLAMACPP_PURGE_DATA "0"

  ; 升级流程（/UPDATE）直接按"保留"处理，不打扰用户
  ${If} $UpdateMode = 1
    Goto llamacpp_keep
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\settings.json"
  ${OrIf} ${FileExists} "$INSTDIR\presets\presets.ini"
  ${OrIf} ${FileExists} "$INSTDIR\webview\EBWebView\*.*"
    ; 静默卸载（/S）不打扰用户，按"保留"处理
    IfSilent llamacpp_keep
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除用户数据？$\r$\n$\r$\n包括设置、presets、压测记录、WebView 缓存（localStorage），$\r$\n以及 runtime 目录（你自己下载或编译的 llama.cpp，可能有几十 GB）。$\r$\nDelete user data as well? (settings, presets, bench records, WebView cache, and the whole runtime\ directory with your own llama.cpp builds)$\r$\n$\r$\n选「否」将保留这些数据，重新安装后继续使用。$\r$\nChoose No to keep them - reinstalling will reuse them." IDYES llamacpp_purge IDNO llamacpp_keep
    Goto llamacpp_keep
llamacpp_purge:
    StrCpy $LLAMACPP_PURGE_DATA "1"
llamacpp_keep:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 覆盖安装：绝不碰用户数据（理由见文件头）
  ${If} $UpdateMode = 1
    Goto llamacpp_purge_done
  ${EndIf}

  ${If} $LLAMACPP_PURGE_DATA == "1"
    ; 递归删除前必须确认这就是本应用的安装目录。卸载器的 $INSTDIR 由 `_?=` 参数或
    ; exe 所在目录推断，为空时 "$INSTDIR\runtime" 会退化成"当前盘根\runtime"，
    ; 递归删掉盘根下的同名目录是不可接受的。没有本应用的数据 = 没有东西要删，直接跳过。
    ; 注意用 ${FileExists}（IfFileExists 对目录同样为真）：LogicLib 没有 ${DirExists}，
    ; 写了它不会报"未定义"，而是把宏参数错位、最后以 `_If requires 4 parameter(s)` 收场。
    ${If} ${FileExists} "$INSTDIR\presets"
    ${OrIf} ${FileExists} "$INSTDIR\webview"
    ${OrIf} ${FileExists} "$INSTDIR\settings.json"
      Delete "$INSTDIR\settings.json"
      Delete "$INSTDIR\gguf-meta-cache.json"
      Delete "$INSTDIR\models-scan-cache.json"
      Delete "$INSTDIR\removed-preset-sections.json"
      RMDir /r "$INSTDIR\presets"
      RMDir /r "$INSTDIR\bench"
      RMDir /r "$INSTDIR\runtime"
      RMDir /r "$INSTDIR\webview"
      ; 数据删完，安装目录若已空就一并收掉（uninstall.exe 还在时会失败，无妨）
      RMDir "$INSTDIR"
    ${EndIf}
  ${EndIf}

llamacpp_purge_done:
  ; `$APPDATA\dev.llamacpp.gui` / `$LOCALAPPDATA\dev.llamacpp.gui`（旧版非便携安装
  ; 的残留）由模板自己清理：它挂在卸载界面「删除应用数据」复选框上，并且已经带了
  ; `$UpdateMode <> 1` 守卫（installer.nsi 的 `$DeleteAppDataCheckboxState` 分支）。
  ; 这里**故意不再删一遍** —— 否则用户没勾那个复选框、只在本文件的弹窗里选了「是」，
  ; 系统目录里的数据也会被删掉，等于绕过了那个复选框。
!macroend
