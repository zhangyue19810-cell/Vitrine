# Vitrine 琉匣

Vitrine 是一个 Minecraft Java 版启动器，目前主要面向 Windows x64。它的主界面是玻璃柜，一个游戏实例对应一盘磁带。模组、光影、资源包和整合包的下载页是一条莫比乌斯环，项目信息直接铺在档案表面。

界面用 Three.js 写，前端基于 [RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）修改，后端是 TypeScript。项目与 Mojang、Microsoft 没有关联。

## 能做什么

**游戏和加载器**

可以安装原版 Minecraft，也可以装 Fabric、Quilt、Forge、NeoForge 和 OptiFine。启动器会检查 Java，缺失时下载 Mojang 提供的运行时，还会根据实例里的模组数量估算内存。

每个实例有自己的游戏目录和启动配置，可以单独指定账号、JVM 参数、窗口大小、全屏和启动后的行为。

**账号**

支持微软、离线和外置登录。微软登录使用设备代码流程，内置的公共 Azure 客户端已经通过 Mojang 审核，不需要自己注册应用，也可以在设置里换成自己的 Client ID。离线账号可以固定 UUID，改名后存档和背包还能对应上。登录令牌保存在系统密钥存储里。

**模组和整合包**

可以从 Modrinth 和 CurseForge 搜索、下载模组、光影、资源包和整合包，也可以导入 `.mrpack`、CurseForge 压缩包和 MultiMC 实例。安装前会检查游戏版本、加载器和前置模组。本地模组可以启用、禁用和删除。

**下载**

下载器支持多文件并行、大文件分段、断点续传、失败换源、哈希校验、限速和重试。游戏文件默认使用 BMCLAPI 镜像，模组默认使用官方源，失败后再走 MCIM。

**其他**

存档和服务器列表都能在启动器里管理，服务器条目会显示延迟和 MOTD。游戏异常退出后会分析日志，给出常见崩溃原因。实例可以导出成启动脚本，单独用来启动游戏。

## 莫比乌斯档案环

内容下载页没有普通列表，也没有单独的下载弹窗。所有档案卡沿着一条真实的莫比乌斯带排成一圈，卡片的方向取自曲面的局部切线、法线和副法线。绕环一圈后，卡片的正面和背面会自然翻转。

每张档案卡上绘制了项目图片、标题、作者、简介、分类和下载量，正反面都有内容。鼠标停在卡片上时，卡片会浮起并显示信息提示框。单击档案会平滑移动镜头并对焦，再点一次可以进入这个项目的版本列表。

滚轮和方向键用来沿环切换档案，拖动鼠标可以绕着环观察。安装或下载时，进度条和状态文字直接画在对应的档案表面，不会弹出新的下载界面。开启系统的“减少动态效果”后，位移动画会缩短。

如果只想看这一部分，可以运行：

```bash
npm run build:mobius-preview
python3 -m http.server 4173 --directory .stage/mobius-preview
```

打开 `http://127.0.0.1:4173/` 就能看到浏览器版。它使用本地示例数据，不会连接启动器后端。拖动可以转视角，滚轮切换档案，双击档案会模拟下载。

## 当前状态

版本是 0.1.0。后端主要流程有自动化测试，界面在 Linux 上跑过，Windows 包用官方 Electron 重新打包。我还没有在真实 Windows 机器上长时间使用过，也没有用真实微软账号把 Xbox Live、XSTS 和 Minecraft 服务整条登录流程走完。

Windows 包没有代码签名，SmartScreen 可能会拦。遇到问题时，请附上 `%APPDATA%\Vitrine\logs` 里最新的日志。

## Windows 使用

下载 `Vitrine-0.1.0-win-x64.zip`，解压后运行 `Vitrine\Vitrine.exe`，不需要安装。更详细的说明在 [docs/WINDOWS-README.txt](docs/WINDOWS-README.txt)。

数据默认放在 `%APPDATA%\Vitrine`。如果想让数据跟着程序目录走，在 `Vitrine.exe` 旁边新建一个空的 `portable.txt`，数据会写进 `data\`。

CurseForge 需要一个免费 API 密钥。不填也能用 Modrinth 和内容镜像。

## 从源码运行

需要 Node.js 22 或更新版本。

```bash
npm install

npm run dev:demo      # 终端 1：本地假服务和示例数据，不联网
npm run dev           # 终端 2：Vite，打开 dev:demo 输出的链接
npm run dev:backend   # 或者改用真实后端，会联网

npm start             # 构建后用 Electron 打开
npm test              # 后端测试
npm run typecheck     # 检查界面、核心和 Electron
npm run build
npm run dist:win      # 生成 release/Vitrine-<版本>-win-x64.zip
```

`dist:win` 在 Linux、macOS 和 Windows 上都能运行。它会下载固定版本的 Electron Windows 运行时，把应用写进 `resources/app.asar`，再处理图标、版本号和语言包。国内网络慢时可以设置 `ELECTRON_MIRROR`，或者用 `ELECTRON_ZIP` 指向已经下载好的 `electron-v<版本>-win32-x64.zip`。

`.github/workflows/build.yml` 里有一份 GitHub Actions 配置，但我没有实际跑过。

## 下载源

游戏文件、加载器和资源默认走 BMCLAPI 镜像，也可以改用官方源。Modrinth 和 CurseForge 的内容默认走官方源，失败后尝试 MCIM。

设置 → 下载 里可以选择官方优先、镜像优先、只用官方或只用镜像，也可以修改镜像地址。请遵守这些服务的使用条款，不要把线程数开得太高。

## 源码结构

```text
core/src/       后端。网络、版本安装、加载器、Java、账号、整合包、内容、存档、崩溃分析
core/test/      后端测试和本地 mock 服务
electron/       主进程、preload、app:// 协议、窗口和托盘
src/            界面，Vite + Three.js
scripts/        开发服务、图标、Electron 和 Windows 打包脚本
```

桌面版通过 Electron IPC 连接后端，页面里没有 Node 环境，也不监听端口。开发模式使用本地 WebSocket，并检查令牌、Origin 和 Host。两种模式共用同一张 RPC 表和事件流。

## 许可

MIT，见 [LICENSE](LICENSE)。界面基于 LBEILC 的 RhineLabUI（MIT）。字体、Electron、Chromium 和其他第三方组件的声明在 [NOTICE](NOTICE) 和 `THIRD-PARTY-LICENSES.txt` 里。重新生成第三方许可列表可以运行 `node scripts/gen-licenses.mjs`。

Minecraft 是 Mojang Synergies AB 和 Microsoft 的商标。
