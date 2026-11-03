# Vitrine 琉匣

一个 Minecraft 启动器：原创的 TypeScript 后端 + 基于 [RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）改造的 3D 玻璃陈列柜界面。
每个游戏实例是柜子里的一盘磁带；打开一盘，就进入它的详情页。

- **后端**覆盖启动器的主要流程：版本安装、Fabric / Quilt / Forge / NeoForge / OptiFine、Java 检测与自动下载、
  离线 / 微软 / 外置登录、整合包导入导出、Modrinth / CurseForge 内容、模组 / 存档 / 服务器管理、崩溃分析。
  **没有使用 PCL2 的任何源代码**；下载源与 PCL2 相同（官方源 + BMCLAPI / MCIM 镜像）。
  与 PCL2 的逐项对照见 [docs/PCL2-FEATURE-MATRIX.md](docs/PCL2-FEATURE-MATRIX.md)——**没有做到“全部功能”**，没做的也列在里面。
- **整合包与大批量下载**用多线程下载引擎：默认 32 个文件并行、大文件分段 + 断点续传、失败自动换源、哈希校验、限速。
- **界面**重点放在性能：窗口失焦、最小化、启动游戏、游戏运行期间自动暂停或降帧 3D 动画，必要时释放显存，
  回到启动器窗口自动恢复。
- 名称、图标、开屏动画都是原创的。

状态：0.1.0。后端有 217 项自动化测试；界面和 Electron 外壳在 Linux 上做过浏览器与冒烟测试；
Windows 版是用官方 Electron 运行时重新打包的，**还没有在真实 Windows 上长期使用过**。

## 使用（Windows）

下载 `Vitrine-0.1.0-win-x64.zip`，解压后双击 `Vitrine\Vitrine.exe`，不需要安装。
首次运行 SmartScreen 可能拦截（没有代码签名证书）。详细说明见 [docs/WINDOWS-README.txt](docs/WINDOWS-README.txt)。

- 数据在 `%APPDATA%\Vitrine`；在 `Vitrine.exe` 旁边放一个空的 `portable.txt` 就变成便携模式（数据放进 `data\`）。
- **微软正版登录需要你自己的 Azure 应用 ID**（设置 → 账号与密钥），而且新应用要通过 Mojang 的审核；不填也能用离线 / 外置登录。
- CurseForge 需要免费申请的 API 密钥（可选；不填仍可用 Modrinth 与内容镜像）。

## 从源码运行

需要 Node.js 22+。

```bash
npm install

npm run dev:demo      # 终端 1：假的 Mojang / 镜像 / Modrinth + 预置实例、模组、存档、服务器；完全不联网
npm run dev           # 终端 2：Vite 界面；打开 dev:demo 打印出的链接
npm run dev:backend   # 或者用真实后端（数据在 ~/.vitrine-dev，会联网）

npm start             # 构建并用 Electron 窗口运行
npm test              # 后端测试（本地 mock 服务器，不联网）
npm run typecheck     # 界面、核心、Electron 外壳三个工程
npm run build         # vite build + 打包 Electron 主进程到 dist-electron/
npm run dist:win      # 生成 release/Vitrine-<版本>-win-x64.zip（见下）
```

`npm run dist:win` 在 Linux / macOS / Windows 上都能运行：它下载官方 Electron（与 `package.json` 里固定的版本一致）
的 Windows 运行时，把应用写进 `resources/app.asar`，用 resedit 改图标与版本信息，瘦身语言包，压缩成 zip。
GitHub 访问慢时，可以设置 `ELECTRON_MIRROR`（镜像根地址，例如 npmmirror 的 electron 镜像），
或者用 `ELECTRON_ZIP` 指向手动下载好的 `electron-v<版本>-win32-x64.zip`。
`.github/workflows/build.yml` 里有同样流程的 GitHub Actions 配置（我没有在 GitHub 上实际跑过它）。

## 结构

```
core/src/      核心（与界面无关，Electron 与开发服务器共用）
  net/         HttpClient、官方↔镜像路由、多线程下载引擎、服务器 ping
  mc/          版本 JSON、规则、classpath、natives、assets、JVM 参数、启动命令
  loaders/     Fabric / Quilt / Forge / NeoForge / OptiFine 安装
  java/        Java 检测、Mojang 运行时下载
  account/     离线、微软（设备码）、外置登录（authlib-injector）、令牌加密
  pack/        mrpack / CurseForge / MultiMC / MCBBS 导入、修复、导出
  content/     Modrinth / CurseForge 搜索与安装、本地模组解析
  world/       存档（NBT）、服务器列表
  crash/       崩溃分析
  tasks.ts     任务管理（进度、取消、界面刷新频率）
  rpc.ts       88 个 RPC 方法；界面与核心之间唯一的接口
core/test/     217 项测试和本地 mock 服务器（假 Mojang / Modrinth / 假游戏 jar）
electron/      主进程、preload、app:// 协议、窗口、托盘、系统密钥保护
src/           界面（Vite + three.js）；src/app/perf*.ts / scheduler.ts 是动画暂停与降帧策略
scripts/       dev-backend、dev-demo、图标生成、Electron 打包、Windows 打包、第三方许可汇总
```

界面与核心的连接：桌面版走 Electron IPC（`window.vitrine`，页面里没有 Node，也不开放任何端口）；
开发时走本地 WebSocket（令牌 + Origin / Host 检查）。两边用同一张 RPC 表和同一个事件流。

## 下载源

| | 官方 | 镜像 |
|---|---|---|
| 游戏文件、Forge / NeoForge / Fabric / Quilt、assets、libraries | Mojang、各加载器官方 Maven / 元数据 | [BMCLAPI](https://bmclapi2.bangbang93.com) |
| Modrinth / CurseForge 元数据与文件 | `api.modrinth.com`、`api.curseforge.com`、各自的 CDN | [MCIM](https://mod.mcimirror.top) |

每类有四种策略：官方优先、镜像优先、只用官方、只用镜像（设置 → 下载）。游戏文件默认镜像优先，模组 / 整合包默认官方优先，
官方失败或太慢时自动换另一边；镜像地址可以改。请遵守这些服务的使用条款，不要把线程数调得过高。

## 已知限制

见 [docs/PCL2-FEATURE-MATRIX.md](docs/PCL2-FEATURE-MATRIX.md) 最后一节。最重要的几条：没有内置微软登录的 Client ID；没有自定义背景 / 音乐 /
联机 / 皮肤更换；崩溃分析的规则库有限；Windows 版没有签名，也还没在真机上充分使用。

## 许可

MIT，见 [LICENSE](LICENSE)。界面基于 LBEILC 的 RhineLabUI（MIT）；第三方组件、字体与运行时的声明见 [NOTICE](NOTICE) 和
`THIRD-PARTY-LICENSES.txt`（`node scripts/gen-licenses.mjs` 重新生成）。Minecraft 是 Mojang Synergies AB / Microsoft 的商标，
本项目与它们没有任何关联。
