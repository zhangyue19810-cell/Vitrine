Vitrine 琉匣 0.1.0 —— Minecraft 启动器（Windows 64 位便携版）
====================================================================

一、怎么打开
  双击 Vitrine.exe 即可。不需要安装，也不需要管理员权限。
  系统要求：Windows 10 或更新的 64 位系统。

  第一次打开时，Windows SmartScreen 可能提示“已保护你的电脑 / 未知发布者”。
  原因：这个程序没有购买代码签名证书。点“更多信息”→“仍要运行”即可。
  想确认文件没被改过，可以对照压缩包旁边的 SHA256SUMS.txt。

二、数据放在哪
  默认：%APPDATA%\Vitrine
        里面有 settings.json（设置）、accounts.json / secrets.json（账户，令牌经 Windows
        数据保护加密）、cache（缓存）、logs（日志），以及默认的游戏目录 minecraft。
  便携模式：在 Vitrine.exe 同一个文件夹里新建一个空文件，名字叫 portable.txt，
        之后所有数据都放进 Vitrine.exe 旁边的 data 文件夹，整个文件夹可以拷到别的电脑 / U 盘。
  游戏目录：设置 → 通用 → 游戏目录 可以改到别处，例如 D:\Games\.minecraft。
        同一页的“已发现的游戏目录”会列出电脑上已有的 .minecraft，点一下就能直接使用。

三、第一次使用
  1. 进入“新建实例”，选 Minecraft 版本，需要的话再选 Fabric / Quilt / Forge / NeoForge / OptiFine。
     也可以把 .mrpack、CurseForge 的 .zip、MultiMC / Prism 的 .zip 整合包直接拖进窗口导入。
  2. 左下角账户：可以添加离线账户、外置登录（authlib-injector）或微软账户（见下文第五条）。
  3. 点“启动”。没有合适的 Java 时，启动器会自动下载 Mojang 提供的运行时（可在 设置 → Java 里关闭）。

四、下载源与速度
  设置 → 下载：
  · 游戏文件下载源 / 模组·整合包下载源：官方源优先、镜像源优先、只用官方、只用镜像，四种策略。
    官方源 = Mojang、Fabric、Forge、NeoForge、Modrinth、CurseForge 的原始地址；
    镜像源 = BMCLAPI（游戏文件）和 MCIM（模组内容）。地址可以改。
  · 并行下载线程（默认 64）、单文件分段数（默认 8 段，可断点续传）、限速、重试次数、代理都可以调。
    整合包有成千上万个小文件，线程多比较快；网络不稳或被限流时调低。

五、账号与密钥
  · 微软正版登录已内置通过 Mojang 审核的公共 Azure 客户端 ID，正常不需要自己注册应用。
      如果要用自己的应用，可在 设置 → 账号与密钥 覆盖 Client ID；应用需要：
      “任何组织目录中的账户和个人 Microsoft 账户” + “允许公共客户端流”，
      并按照 Mojang 的说明（https://aka.ms/AppRegInfo）提交审核。
      审核通过前，Minecraft 服务会拒绝登录，启动器会提示“app-not-approved”。
      离线账户和外置登录不受影响。
  · CurseForge API 密钥（可选）：到 CurseForge for Studios 控制台免费申请，填进同一页。
      不填时仍然可以用 Modrinth，以及内容镜像提供的 CurseForge 数据。

六、窗口动画与性能
  · 启动游戏后，启动器的 3D 动画会暂停并让出显卡；你回到启动器窗口时自动恢复。
  · 窗口失去焦点或最小化时默认也会暂停（可在设置里改成“降到 10 帧”或“保持不变”）。
  · 设置 → 外观与性能 可以调帧率上限、画质、是否释放显存、开屏动画长短。
  · 快捷键：Ctrl+K 打开搜索 / 命令面板，Ctrl+, 打开设置。

七、遇到问题
  · 窗口黑屏 / 3D 画面异常：先把 设置 → 外观与性能 → 3D 画质 调到“低”；
    还不行就在快捷方式的目标后面加上  --disable-gpu  再打开。
  · 日志在 %APPDATA%\Vitrine\logs（便携模式在 data\logs）。反馈问题时请附上最新的日志。
  · 这是 0.1.0 的第一个版本：核心有自动化测试，界面和 Electron 外壳在 Linux 上做过冒烟测试，
    但还没有在真实的 Windows 机器上长时间使用过。遇到问题很可能是我们没覆盖到的情况，请反馈。

八、卸载
  直接删除 Vitrine 文件夹。想连数据一起清掉，再删除 %APPDATA%\Vitrine（便携模式则没有这一步）。
  游戏目录里的存档和模组由你自己决定是否保留。

九、许可
  Vitrine 以 MIT 许可发布（LICENSE.vitrine.txt）。界面基于 LBEILC 的 RhineLabUI（MIT）。
  第三方组件、字体（MiSans）与 Electron / Chromium 的许可见 NOTICE.txt、THIRD-PARTY-LICENSES.txt、
  LICENSE 与 LICENSES.chromium.html。
