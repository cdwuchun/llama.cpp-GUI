// 后端单测：TMP/TEMP 指到工作区 `tmp/test-temp` 再跑 cargo test。
//
// 为什么不用系统的 %TEMP%：本机 `C:\Users\<用户>\AppData\Local\Temp` 下的测试目录对
// cargo test 子进程会报「拒绝访问 (os error 5)」，settings / models / strata 一批用例
// 全挂；换成仓库内目录就正常（tmp/ 已在 .gitignore 里）。
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const tmp = path.join(process.cwd(), "tmp", "test-temp");
mkdirSync(tmp, { recursive: true });

const result = spawnSync(
  process.platform === "win32" ? "cargo.exe" : "cargo",
  ["test", "--lib", "--manifest-path", path.join("src-tauri", "Cargo.toml")],
  { stdio: "inherit", env: { ...process.env, TMP: tmp, TEMP: tmp } },
);
process.exit(result.status ?? 1);
