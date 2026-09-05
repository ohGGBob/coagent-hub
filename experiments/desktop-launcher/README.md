# 实验：Windows 桌面启动器（.bat）生成

日期：2026-09-05　状态：**生成与校验完成，待真机双击验证**

## 目标

降低 CoAgent Hub 的使用门槛：双击就能启动服务 / 打开命令行 / 打开项目目录。
按尤利乌斯要求，**全程只在工作区内实验，不碰用户桌面**。

## 产物

`out/` 目录（GBK 编码，可直接拷到任意位置双击）：

| 文件 | 作用 |
|------|------|
| `coagent-hub-start.bat` | 启动 Hub 服务（node src\server.js），退出后窗口保留 |
| `coagent-cli.bat` | 打开定位到项目根的交互终端 |
| `coagent-project-folder.bat` | 资源管理器打开项目目录 |

重新生成：`node experiments/desktop-launcher/generate.mjs`

## 实验步骤与结论

1. **直接写 UTF-8 → 乱码风险**：cmd.exe 按 ANSI 代码页（中文系统 = GBK）解析 .bat，
   UTF-8 直写的中文路径会乱码 → 必须转 GBK。
2. **bash heredoc 生成 → 路径被改写**：Git Bash 的 MSYS 路径转换把内容里的
   `D:\路径` 改写成 `D:/路径` → 内容改由 Node 生成（UTF-8 零损耗），bash 只负责
   `iconv -f UTF-8 -t GBK` 落盘（命令行参数全 ASCII，无转换风险）。
3. **LF 换行 → 隐患**：初版产物是 LF 换行（xxd 验出），.bat 规范应使用 CRLF
   （LF 在 goto 标签等场景会出错）→ 生成器强制 `toCRLF()`。
4. **校验**：GBK→UTF-8 往返一致 ✓；hex 确认 `0d 0a` ✓；路径行
   `cd /d "D:\CoAgent项目开发"` 反斜杠完好 ✓（grep 断言需避开反斜杠转义陷阱，
   用字符类 `D:.CoAgent` 或 -F 短模式）。

## 沙箱限制（无法在此环境完成的事）

- cmd.exe 被沙箱整体禁用（`cmd /c echo` 都不行），**双击行为无法代测**；
- COM 组件（WScript.Shell 建 .lnk）也被禁 → 只能产出 .bat 而非真快捷方式。

## 待办（真机验证清单）

1. 资源管理器打开 `experiments/desktop-launcher/out/`，双击 `coagent-hub-start.bat`
   → 应弹出窗口启动 Hub 并打印局域网地址；Ctrl+C 停止。
2. 双击 `coagent-cli.bat` → 终端落在项目根，`npm run hub -- status` 可用。
3. 验证通过后，可手动把三个 .bat 拷到桌面，或发 `npm run desktop` 式的一键脚本
   （生成器已就绪，加个 package.json script 即可）。
