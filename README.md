# Vitrine 琉匣

Vitrine 是一个 Minecraft Java 版启动器。主界面用 Three.js 做成玻璃陈列柜，每个游戏实例是一盘磁带，点开后才进入详情页。

后端用 TypeScript 写，前端基于 [RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）修改。现在可以安装原版和 Fabric、Quilt、Forge、NeoForge、OptiFine，检测和下载 Java，登录微软、离线或外置账号，导入整合包，搜索和安装 Modrinth、CurseForge 的内容，也能管理模组、存档和服务器。下载页没有单独的列表或弹窗，档案卡挂在莫比乌斯环上，筛选、版本信息和下载进度都显示在卡面。

项目没有使用 PCL2 的代码。下载源和 PCL2 一样，使用官方地址加 BMCLAPI、MCIM 镜像。功能对照和未完成的部分在 [docs/PCL2-FEATURE-MATRIX.md](docs/PCL2-FEATURE-MATRIX.md)。

## 目前状态

版本 0.1.0。后端主要流程有自动化测试，界面在 Linux 上跑过，Windows 包用官方 Electron 重新打包。我还没有在真实 Windows 机器上长时间使用过，也没有用真实微软账号把 Xbox Live、XSTS 和 Minecraft 服务整条登录流程走完。

Windows 包没有代码签名，SmartScreen 可能会拦。遇到问题请附上 `%APPDATA%\Vitrine\logs` 里的最新日志。

## Windows

下载 `Vitrine-0.1.0-win-x64.zip`，解压后运行 `Vitrine\Vitrine.exe`，不需要安装。使用说明在 [docs/WINDOWS-README.txt](docs/WINDOWS-README.txt)。

数据默认放在 `%APPDATA%\Vitrine`。如果想让数据跟着文件夹走，在 `Vitrine.exe` 旁边新建一个空的 `portable.txt`，数据会放进 `data\`。

微软登录已经填好通过 Mojang 审核的公共 Azure 客户端 ID，不用自己注册应用。也可以在 设置 → 账号与密钥 里换成自己的 Client ID。离线登录和外置登录不走这个配置。

CurseForge 需要自己申请一个免费 API 密钥。不填也能使用 Modrinth 和内容镜像。

## 莫比乌斯环预览

如果只想看下载页里的 3D 部分，可以在项目根目录执行：

```bash
npm run build:mobius-preview
python3 -m http.server 4173 --directory .stage/mobius-preview
```

然后打开 `http://127.0.0.1:4173/`。预览用的是本地示例数据，不会连接启动器后端。按住拖动可以转视角，滚轮切换档案，双击档案会显示模拟的下载进度。

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

`dist:win` 在 Linux、macOS 和 Windows 上都能用。它会下载 `package.json` 中固定版本的 Electron Windows 运行时，写入 `resources/app.asar`，再处理图标、版本号和语言包。国内网络慢时可以设置 `ELECTRON_MIRROR`，或者用 `ELECTRON_ZIP` 指向自己下载好的 `electron-v<版本>-win32-x64.zip`。

`.github/workflows/build.yml` 里有一份 GitHub Actions 配置，但我没有实际跑过。

## 目录

```text
core/src/       后端。网络、版本安装、加载器、Java、账号、整合包、内容、存档、崩溃分析
core/test/      后端测试和本地 mock 服务
electron/       主进程、preload、app:// 协议、窗口和托盘
src/            界面，Vite + Three.js
scripts/        开发服务、图标、Electron 和 Windows 打包脚本
```

桌面版通过 Electron IPC 连接后端，页面里没有 Node 环境，也不监听端口。开发模式使用本地 WebSocket，并检查令牌、Origin 和 Host。两种模式共用同一张 RPC 表和事件流。

## 下载源

游戏文件、加载器和资源默认走 BMCLAPI 镜像，也可以改成官方源。Modrinth 和 CurseForge 的内容默认走官方源，失败后尝试 MCIM。

设置 → 下载 里可以选官方优先、镜像优先、只用官方或只用镜像，也可以改镜像地址。请遵守这些服务的使用条款，不要把线程数开得太高。

## 许可

MIT，见 [LICENSE](LICENSE)。界面基于 LBEILC 的 RhineLabUI（MIT）。字体、Electron、Chromium 和其他第三方组件的声明在 [NOTICE](NOTICE) 与 `THIRD-PARTY-LICENSES.txt`。重新生成第三方许可列表可以运行 `node scripts/gen-licenses.mjs`。

Minecraft 是 Mojang Synergies AB 和 Microsoft 的商标。这个项目与它们没有关联。
