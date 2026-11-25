# Vitrine 琉匣

Vitrine 是一个 Minecraft Java 版启动器，目前主要面向 Windows x64。作者：**wind3542**。

界面用 Three.js 写，前端基于 [RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）修改，后端是 TypeScript。项目与 Mojang、Microsoft 没有关联。

状态：0.1.0。这次整合了 2026-11-22 的黑洞音乐播放器、3D 歌词与黑金光影，2026-11-24 的深黑配色、交错切页和 3D 卡片动效，以及 2026-11-25 的 PBR 环体材质、自定义下载、顶部灵动岛和更厚的档案玻璃边缘；具体改动见 [docs/CHANGES-2026-11-22-black-hole-music.md](docs/CHANGES-2026-11-22-black-hole-music.md)、[docs/CHANGES-2026-11-24-cinematic-ui.md](docs/CHANGES-2026-11-24-cinematic-ui.md) 与 [docs/CHANGES-2026-11-25-personalization.md](docs/CHANGES-2026-11-25-personalization.md)。界面和 Electron 外壳在 Linux 上做过浏览器与冒烟测试，Windows 版仍建议先在测试目录试用。

## 能做什么

**游戏和加载器**

可以安装原版 Minecraft，也可以装 Fabric、Quilt、Forge、NeoForge 和 OptiFine。启动器会检查 Java，缺失时下载 Mojang 提供的运行时

所有实例都固定在 `versions/<实例名>` 下面使用自己的游戏目录，存档、模组、配置和截图不会互相串。升级后第一次打开旧实例时，原来共用根目录的 `saves` 会复制到对应实例里，不会直接丢弃。每个实例还可以单独指定 JVM 参数、窗口大小、全屏和启动后的行为。

内存自动档会同时参考物理内存、当前空闲内存、模组数量和 Java 位数；空闲内存偏低时会实时收紧推荐值并写明原因。JVM 默认使用“智能匹配”：原版沿用 Java 默认 GC，小型整合包用 G1，大型整合包自动换用大 Region G1，Java 21+ 且内存充足时再考虑分代 ZGC。设置里的“启动优化”会在启动前清理启动器缓存、请求 V8 回收，并为 G1 补充低停顿和空闲堆回收参数，同时尝试提高游戏进程优先级。

**模组和整合包**

可以从 Modrinth 和 CurseForge 搜索、下载模组、光影、资源包和整合包，也可以导入 `.mrpack`、CurseForge 压缩包和 MultiMC 实例。导入 `.mrpack` 时也兼容其中引用 CurseForge CDN 的文件地址；只接受 HTTPS 受信任域名，并且要求文件大小和 SHA 校验值齐全，未知域名或无校验信息的条目会跳过。搜索会同时查询 Modrinth 和 CurseForge，把两边结果合并去重并按相关度排序，不再需要手动切换来源。搜索支持中文关键词、拼写容错和关键词拆分，结果太少时会自动换成相关词，不会因为少打一个字就什么都搜不到。下载页可以按游戏版本和加载器筛选，项目简介会尝试自动翻译成中文，翻译服务不可用时显示原文

**下载**

下载器默认同时下载 64 个文件，大文件默认 8 段并行，游戏主程序单独使用 16 段。安全下载分三层：

1. **多线程分块**：使用 HTTP Range 并发下载。
2. **单线程回退**：Range 不支持、分块异常或重试失败时，关闭分块，改走普通 HTTP 流。
3. **镜像回退**：连接中断或当前来源不可用时切换备用源，并重新执行完整性校验。

文件先写入 `.vtmp` / `.vseg` 临时文件，按可用的 SHA-512 / SHA-256 / SHA-1 校验，然后原子替换正式文件；校验失败不会覆盖已有文件。支持断点续传、失败换源、限速和重试。游戏文件和模组内容默认优先使用镜像，失败后再回退官方源。

右上角账号胶囊展开后可以打开“自定义下载”，粘贴任意 HTTP(S) 地址并选择保存文件夹。GitHub 地址会同时测速直连、阿里云/华清云镜像和 GH 云加速，自动采用实际最快且返回文件内容的来源，其他可用来源保留为回退；大文件沿用多段 Range 下载。

**音乐**

新增“音乐”页：内置网易云网页版客户端、扫码登录、推荐/榜单/每日推荐/我的歌单、搜索与播放队列，并接入网易云“一起听”房间（创建/加入/心跳/播放状态同步）。音乐页沿用更新包的黑洞与吸积盘、金色光子环、跟随音乐跳动的 3D 歌词、右侧抽出的档案卡和“点击黑洞播放/拖动光子环跳转”的交互；播放器控制条和来源控制板在页面下方。歌曲、歌手和歌词在无网络或未登录时按服务提示降级。

**其他**

存档和服务器列表都能在启动器里管理，服务器条目会显示延迟和 MOTD。游戏异常退出后会分析日志，给出常见崩溃原因；诊断会单独列出最先报错的位置和该位置能提取到的模组，缺少前置时会提供一键补齐按钮。模组冲突检查会读取 `breaks` / `incompatible` 的版本范围，已经安装的版本不在范围内时不会误报“不兼容”。安装并启用了 Sinytra Connector（信雅互联）的 NeoForge / Forge 实例会把 Fabric / Quilt 模组视为兼容，不再报加载器不同；依赖检查也会读取 NeoForge jar-in-jar 和嵌套 jar 里的模组 id。Mod 更新检查结果改为浮动玻璃对话框，“需要注意”项目收进悬停弹出的玻璃浮层，不再占用 Mod 列表位置。实例可以导出成启动脚本，单独用来启动游戏。


搜索栏旁边的“MC百科”会按当前关键词打开中文百科搜索，抽出的项目档案上也有“MC百科”按钮，会按项目标题去搜。MC百科只用来查中文资料，下载安装仍然走 Modrinth 或 CurseForge。安装模组时默认会解析并安装必需的前置，已经装过的会跳过；也可以在下载行下关闭“智能安装前置。

界面默认使用更深的**黑金液态玻璃**材质，并提供可降级的亮色主题；切页不使用高斯模糊，而是通过交叉淡化、轻微纵深位移和每 100ms 一层的交错弹入完成，避免切换时挡住内容；正文、导航与控件全局使用 LXGW WenKai 手写楷体，中文大标题使用 Ma Shan Zheng 毛笔楷书，开屏 VITRINE 使用 Kaushan Script 配合逐字落墨动画，Latin 品牌与英文行保留 Source Serif 4 的编辑衬线；页签当前项是一枚会滑动、沿移动方向拉伸并弹性回弹的玻璃胶囊，并移到顶部灵动岛下方避免遮挡。右上角只在悬停账号总按钮时展开搜索、收藏、下载、自定义下载和设置；菜单从胶囊向下弹出，带阻尼回弹，不再横向伸到灵动岛下方。设置 → 个性化 可以切换九种环体 PBR 材质。档案卡片的玻璃盖层增加了厚度、色散与柔光环，档案外沿改为拉丝香槟金属，内层光学肩部使用深色抛光金属。实例展示卡、下载卡、设置页、Mod 管理和弹窗使用指针跟随的 3D 倾斜与高光；卡片和按钮边框有持续环绕的金色/青色流光，卡面内部还有错峰扫过的斜向柔光；胶囊按钮悬停时像一滴水从指针位置向四周铺满，不做向下滴落的位移。顶部灵动岛按此前 Lumina UI Mod 的纯黑胶囊、蓝色传感器点和四路阻尼弹簧实现；输入后展开 5 秒再收成小黑条，10 秒无操作完全隐藏。下载完成展开 3 秒后收起，播放音乐时用与播放页一致的歌词字体、由白转金、上下行虚化效果显示三行歌词。音乐页沿用更新包的黑洞、吸积盘、3D 歌词与网易云播放器，使用金色光子环和深空反射。3D 自动画质会结合显卡、CPU 核数和物理内存选择档位，帧率持续偏低时再逐级降级；游戏运行时启动器会临时降到低画质，把资源让给游戏。游戏日志和任务日志每次最多显示 6 条报错，避免刷屏；完整日志仍可通过“复制全部”和日志文件夹查看。

## 当前状态



## Windows 使用

下载 `Vitrine-0.1.0-win-x64.zip`，解压后运行 `Vitrine\Vitrine.exe`，不需要安装。更详细的说明在 [docs/WINDOWS-README.txt](docs/WINDOWS-README.txt)。

启动器数据默认放在 `%APPDATA%\Vitrine`。如果想让数据跟着程序目录走，在 `Vitrine.exe` 旁边新建一个空的 `portable.txt`，数据会写进 `data\`。如果更新后不小心弄丢了 `portable.txt`，但 `data\` 里还有设置和缓存，启动器会自动继续使用这份数据。

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
npm run dist:win:setup # 同时生成 NSIS 安装器（需要系统已安装 makensis）
```

`dist:win` 在 Linux、macOS 和 Windows 上都能运行。它会下载固定版本的 Electron Windows 运行时，把应用写进 `resources/app.asar`，再处理图标、版本号和语言包。国内网络慢时可以设置 `ELECTRON_MIRROR`，或者用 `ELECTRON_ZIP` 指向已经下载好的 `electron-v<版本>-win32-x64.zip`。

`.github/workflows/build.yml` 里有一份 GitHub Actions 配置，但我没有实际跑过。

## 下载源

游戏文件、加载器和资源默认走 BMCLAPI 镜像，也可以改用官方源。Modrinth 和 CurseForge 的内容默认走 MCIM 镜像，失败后回退官方源。

设置 → 下载 里可以选择官方优先、镜像优先、只用官方或只用镜像，也可以修改镜像地址。请遵守这些服务的使用条款，不要把线程数开得太高。

## 源码结构

```text
core/src/       后端。网络、版本安装、加载器、Java、整合包、内容、存档、崩溃分析
core/test/      后端测试和本地 mock 服务
electron/       主进程、preload、app:// 协议、窗口和托盘
src/            界面，Vite + Three.js
scripts/        开发服务、图标、Electron 和 Windows 打包脚本
```

桌面版通过 Electron IPC 连接后端，页面里没有 Node 环境，也不监听端口。开发模式使用本地 WebSocket，并检查令牌、Origin 和 Host。两种模式共用同一张 RPC 表和事件流。

## 许可

MIT，见 [LICENSE](LICENSE)。界面基于 LBEILC 的 RhineLabUI（MIT）。字体、Electron、Chromium 和其他第三方组件的声明在 [NOTICE](NOTICE) 和 `THIRD-PARTY-LICENSES.txt` 里。重新生成第三方许可列表可以运行 `node scripts/gen-licenses.mjs`。

Minecraft 是 Mojang Synergies AB 和 Microsoft 的商标。
