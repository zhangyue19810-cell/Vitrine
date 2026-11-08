# Vitrine 琉匣

Vitrine 是一个 Minecraft Java 版启动器，目前主要面向 Windows x64。主界面是一条莫比乌斯档案环：每个游戏实例、以及“新建 / 浏览 / 导入”动作，都是环上一片略微抬高的档案板，当前项会抽到左环开口里正对镜头。点“整合包”“模组”“资源包”“光影”“数据包”后，同一批档案会展开成一条斜向下载行，项目介绍和安装按钮直接印在抽出的 3D 档案上。下载任务仍在单独的任务页里查看。

界面用 Three.js 写，前端基于 [RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）修改，后端是 TypeScript。项目与 Mojang、Microsoft 没有关联。

## 能做什么

**游戏和加载器**

可以安装原版 Minecraft，也可以装 Fabric、Quilt、Forge、NeoForge 和 OptiFine。启动器会检查 Java，缺失时下载 Mojang 提供的运行时，还会根据实例里的模组数量估算内存。

所有实例都固定在 `versions/<实例名>` 下面使用自己的游戏目录，存档、模组、配置和截图不会互相串。升级后第一次打开旧实例时，原来共用根目录的 `saves` 会复制到对应实例里，不会直接丢弃。每个实例还可以单独指定账号、JVM 参数、窗口大小、全屏和启动后的行为。

**账号**

支持微软、离线和外置登录。微软登录使用设备代码流程，内置的公共 Azure 客户端已经通过 Mojang 审核，不需要自己注册应用。离线账号可以固定 UUID，改名后存档和背包还能对应上。登录令牌保存在系统密钥存储里。

**模组和整合包**

可以从 Modrinth 和 CurseForge 搜索、下载模组、光影、资源包和整合包，也可以导入 `.mrpack`、CurseForge 压缩包和 MultiMC 实例。搜索支持中文关键词、拼写容错和关键词拆分，结果太少时会自动换成相关词，不会因为少打一个字就什么都搜不到。下载页可以按游戏版本和加载器筛选，项目简介会尝试自动翻译成中文，翻译服务不可用时显示原文。安装模组时会把必需的前置一起解析好，已经装过的前置会跳过。已安装的模组列表也支持模糊搜索，并按相关度排序。模组诊断会检查重复、缺失或被禁用的前置、加载器不对和无法读取的 jar；缺少前置可以一键下载，被禁用的前置可以一键启用，加载器不对会打开已经选好版本和加载器的新建实例窗口。

**下载**

下载器默认同时下载 64 个文件、每个大文件 8 段并行，支持断点续传、失败换源、哈希校验、限速和重试。游戏文件和模组内容默认优先使用镜像，失败后再回退官方源。

**其他**

存档和服务器列表都能在启动器里管理，服务器条目会显示延迟和 MOTD。游戏异常退出后会分析日志，给出常见崩溃原因；缺少前置时会提供一键补齐按钮。实例可以导出成启动脚本，单独用来启动游戏。

## 内容浏览

点顶部的“整合包”“模组”“资源包”“光影”或“数据包”，首页的档案环会平滑重组成下载行。滚轮或 ←/→ 选择档案，选中的项目会抽到画面左侧，图标、作者、简介、分类、下载量以及“安装 / 选择版本 / MC百科 / 主页”按钮都印在 3D 档案本身上，不再用 HTML 盖在模型上。切换内容类型时，旧档案先向两边散开，新结果再从四周飞入。

下载行下方可以切换 Modrinth / CurseForge、排序、安装目标实例，以及 PCL2 风格的游戏版本和加载器筛选；筛选默认跟随当前实例，也可以手动选择其他版本或“全部”。搜索支持中文关键词、拼写容错和关键词拆分，结果太少时会自动换成相关词，并在结果计数处说明。项目简介会尝试翻译成中文；翻译服务不可用时显示原文。

搜索栏旁边的“MC百科”会按当前关键词打开中文百科搜索，抽出的项目档案上也有“MC百科”按钮，会按项目标题去搜。MC百科只用来查中文资料，下载安装仍然走 Modrinth 或 CurseForge。安装模组时默认会解析并安装必需的前置，已经装过的会跳过；也可以在下载行下关闭“智能安装前置”。

下载任务不放在 3D 舞台里。任务页会显示队列、速度、进度、失败原因和日志，安装完成后可以回到实例详情页查看刚装好的内容。

## 当前状态

版本是 0.1.0。后端主要流程有自动化测试，新的环↔下载行界面有几何、镜头和重组动画测试，Windows 包用官方 Electron 重新打包。当前构建环境没有可用的真实 GPU，所以这一版 3D 界面还没有做完整的实际渲染截图验收；我也没有在真实 Windows 机器上长时间使用过，没有用真实微软账号把 Xbox Live、XSTS 和 Minecraft 服务整条登录流程走完。

Windows 包没有代码签名，SmartScreen 可能会拦。遇到问题时，请附上 `%APPDATA%\Vitrine\logs` 里最新的日志。

## Windows 使用

下载 `Vitrine-0.1.0-win-x64.zip`，解压后运行 `Vitrine\Vitrine.exe`，不需要安装。更详细的说明在 [docs/WINDOWS-README.txt](docs/WINDOWS-README.txt)。

启动器数据默认放在 `%APPDATA%\Vitrine`。如果想让数据跟着程序目录走，在 `Vitrine.exe` 旁边新建一个空的 `portable.txt`，数据会写进 `data\`。如果更新后不小心弄丢了 `portable.txt`，但 `data\` 里还有账号和设置，启动器会自动继续使用这份数据。

Minecraft 游戏目录默认使用系统桌面的 `Minecraft` 文件夹。第一次运行时，如果启动器自己的数据目录里已经有旧的 `minecraft`，会把它整体移动到桌面，并把游戏目录切过去；如果桌面已经有同名文件夹，不会覆盖里面的文件。

官方 Windows 包已经内置 CurseForge 访问配置，不需要用户填写密钥。

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

游戏文件、加载器和资源默认走 BMCLAPI 镜像，也可以改用官方源。Modrinth 和 CurseForge 的内容默认走 MCIM 镜像，失败后回退官方源。

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
