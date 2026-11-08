# 琉匣 Vitrine —— 本次改动说明（2026-11-08）

> 对比对象：您已经提交到仓库的那一版（2026-11-01 的源码包）。本包**只含新增/修改的文件**，按原路径覆盖进仓库即可，**没有需要删除的文件**。
> 状态一句话：**能编译（类型检查、Vite 构建通过），主要几何单测通过，首页 ∞ 环和模组下载行在浏览器里看过；最后一轮调参和若干交互我没来得及验证（见第 5 节），您接手时请先看第 5、6 节。**

---

## 1. 这一版做成了什么

按您历次的要求，界面里能看到、能点的东西都放进了 3D 场景，不再用 HTML 盖在 mod 图片上。

| 您的要求 | 现在的做法 |
|---|---|
| 主界面是档案 3D 模型的**莫比乌斯环** | 首页 = 一条 **∞ 形扭转带**，由 **360 片薄档案板**（"鳍片"）沿八字曲线依次排开，每片比前一片多滚一点，整条带带半圈扭转（奇数个半扭 = 莫比乌斯）。您的实例（和"新建/浏览/导入"）是带上**略高一点的标签板**。选中的那张被抽到**左环的开口里**正对镜头，上面直接印着名称/状态。 |
| 您发来的 RHINE LAB ∞ 参考图 | 这一版就是按那张图重做的（上一版"玻璃带 + 几张大卡"理解错了）。薄片、细肋、白色陶瓷质感、柔和阴影、环悬在空中没有地面。 |
| **点击其他标签才切到 3D 阵列选 mod** | 顶部标签：首页 / 整合包 / 模组 / 资源包 / 数据包 / 光影。点任何非"首页"标签，环**不消失而是重组**：同一批薄片摊平成斜向的肋状轨道，同一批档案排成**一排**，选中的抽到画面左边，滚轮选择。 |
| 下载界面：一排档案、斜视角在相机左上方、选中的左边抽出、鼠标滚轮选择 | `row-track.ts` + `stage-layout.ts`（行相机：方位 −46°、仰角 25°）。选中档案在左边放大，**详情和按钮（安装 / 选择版本… / 主页 ↗）都印在这张 3D 档案上**，点击是射线拾取，不是 HTML 按钮。 |
| 切换分类：档案先向两边不规则抽离，再从四周飞出新档案排好 | `choreography.ts`（scatter / gather），`archive-stage.ts` 的 swap 流程：旧的抽离 → 等内容 → 新的从四周飞入。 |
| 螺旋飞入、每个视图切换都要平滑衔接 | 环→行、行→环、分类切换、首次出现（薄片从下方拼装）都有动画；环→行时每片按离选中档案的远近**错开起步**，边飞边螺旋翻转。 |
| 性能：游戏运行/窗口失焦时暂停动画，聚焦恢复 | 沿用上一版的性能策略（空闲 30fps、深度空闲 15fps、失焦/游戏运行暂停）；环的"慢速起伏"受"空闲动效"偏好控制。 |

---

## 2. 文件清单

### 新增

| 文件 | 作用 |
|---|---|
| `src/fin-band.ts` | **∞ 环的全部数学**（纯数字，不依赖 three.js）：八字中心线、弧长表（板子等距）、每片的朝向（沿路径滚转 + 倾斜 + 慢速起伏）、`lapFlip`（让档案过接缝不倒置）、下载行轨道 `trackPlateAt`、环→行的错开顺序 `unrollOrder/staggered`。常量集中在 `BAND` / `TRACK`。 |
| `src/fin-mesh.ts` | 360 片板的 **InstancedMesh**（一个 draw call、一个阴影投射体）：环↔轨道的形变、从下方拼装、颜色随主题渐变、每片轻微色差。 |
| `src/archive-stage.ts` | **3D 舞台**：≤64 张档案的池；环 / 行两种布局；重组（`regroup`）、分类切换、悬停/点击/滚轮/拖动、相机弹簧、把 canvas 画的面贴到档案上、事件回调给界面。 |
| `src/stage-layout.ts` | 镜头与构图：用"屏幕锚点"表达（"环的中心在画面 28.5% / 50%"），窗口比例变了也成立。`ringCamera / rowCamera / holePlacement / detailPlacement`。 |
| `src/row-track.ts` | 下载行的几何（凹弧，R=46，间距 6.3）。 |
| `src/regroup.ts` | 环↔行时"哪张档案变成哪张"的记账（`unroll` / `roll`）。 |
| `src/choreography.ts` | 动作曲线：螺旋飞入、不规则抽离、四周飞入、飞行中的翻面。纯函数。 |
| `src/mobius-ring.ts` | 只剩共享的 `RingFrame` 类型、`newFrame`、`wrapSigned`（旧的圆环数学已删除，被 `fin-band.ts` 取代，文件名没改以免动 import）。 |
| `src/app/download.ts` | 下载视图的控制器：搜索、分类、排序、"安装到"哪个实例、图标晚到、分页、安装/选版本按钮。 |
| `src/app/faces.ts` | 画在 3D 档案上的内容（小卡面 / 悬停信息面 / 左边抽出的大详情面 + 按钮热区），纯绘制。 |
| `src/app/stage-items.ts` | 把实例、动作档案、在线项目转成舞台条目。 |
| `src/app/tabs.ts` | 顶部标签条。 |
| `src/styles/stage.css` | 标签条和下载行下方控件的样式。 |
| `core/src/content/icons.ts` | 在线项目图标由核心取回并转成 `data:` URL（3D 要读像素，跨域 `<img>` 读不了）。只允许已知 CDN 域名和小图片。 |
| `core/test/` 下 6 个测试 | `fin-band`(13) `stage-layout`(8) `regroup`(9) `choreography`(17) `row-track`(5) `icons`(3)。 |

### 修改

| 文件 | 改了什么 |
|---|---|
| `src/scene.ts` | 承载舞台：`installStage / setStageActive / updateStage`；本轮新增 `shapeSurroundings()`（环形态下地面移到 y=−34 并隐藏、光源改为从正面照、阴影窗口放大到 ±23×±19，行形态各自平滑渐变回旧值）；`detail`（右半屏纸色遮罩）在行形态改为 0，**修掉了"模组行右半边被蒙白"**。 |
| `src/app/app.ts` | 视图状态（`home` / `browse`）、标签切换、舞台事件接线、性能策略接入。 |
| `src/app/scene-host.ts` | 创建舞台、把界面数据喂给它、转发事件；`setTier` 等。 |
| `src/app/shortcuts.ts` | 环上 ←/→ 转环、PgUp/PgDn 换分组；下载行 Enter 安装、Esc 回首页。 |
| `src/app/home.ts` | 标签条和下载视图的容器、新的快捷键提示。 |
| `src/app/views/browse.ts` | 抽出 `chooseVersion / install / SORTS` 给下载视图复用（无舞台时仍可回退到旧的浏览面板）。 |
| `src/app/api.ts` | 新 RPC 的类型 `content.icon`。 |
| `src/data.ts` | 档案数据结构加入动作档案 / 条目类型 / 悬停信息（`ArchiveAction`、`ItemType`、`ItemFacts`）。 |
| `src/main.ts` | 引入 `stage.css`。 |
| `core/src/core.ts`、`core/src/rpc.ts` | 图标取回器；`content.icon`（RPC 88 → 89）。 |
| `README.md` | RPC 数 89、测试数 272。 |

> 本次中途新增又删除的 `src/ribbon.ts`、`core/test/ribbon.test.ts`、`core/test/mobius-ring.test.ts`（旧"玻璃带"代码）您的基线里没有，不用处理。
> 除 `stage.css` 外的样式文件、`electron/`、打包脚本都没动。Windows 便携包**没有**重新打。

---

## 3. 怎么跑

```bash
npm install
npm run typecheck          # 三套 tsconfig
npm test                   # 272 项（我在最后一轮改动后只跑了相关 4 个文件，见第 5 节）
npm run build:web
# 看界面（不碰外网，核心是真的，网络源是本地假的）：
npm run dev:demo           # 终端会打印带 ?backend=… 的链接
npm run dev                # 另一个终端；打开 dev:demo 打印的链接，末尾加 &debug
```

- 加 `&debug` 后控制台有 `window.__vitrine`：`host.stage.describe()`、`host.stage.cameraState()`、`step(n)`（手动走 n 帧）、`host.setTier("high")`。
- **没有 GPU / 软件渲染的机器会被自动判成 `minimal` 档**（60% 分辨率、无 AO/景深/抗锯齿），看起来会发糊，判断画面请切到 `high`。
- 键盘：首页 ←/→ 转环、PgUp/PgDn 换分组、Enter 启动、Space 管理、`/` 搜索；下载行滚轮/←/→ 选择、Enter 安装、Esc 回首页。

---

## 4. 调参在哪里（都是常量）

| 想改什么 | 在哪 |
|---|---|
| 环的形状：半宽 `radius`、纵向拉伸 `squash`、前后错开 `depth`、扭转圈数 `twist`、起始滚转 `phase`、倾斜 `lean`、板子尺寸 `plate`、片数 `count`、起伏 `wave` | `src/fin-band.ts` → `BAND` |
| 下载行轨道（长度、宽度、下沉、倾斜、板子尺寸） | `src/fin-band.ts` → `TRACK` |
| 环在画面里的位置和大小（中心 u/v、占宽比例 `share`）、两种视角 | `src/stage-layout.ts` → `RING_VIEW`、`VIEW` |
| 选中档案在左环里的大小/抬高/转向 | `src/stage-layout.ts` → `HOLE` |
| 环上档案比板子大多少 | `src/archive-stage.ts` → `RING_CARD` |
| 板子材质、色差 | `src/fin-mesh.ts` 构造函数 |
| 环的光源位置、地面高度、阴影窗口 | `src/scene.ts` 顶部 `RING_LIGHT / FLOOR_HEIGHT / SHADOW_WINDOW` |
| 镜头长度（越长越"压扁"） | `src/stage-layout.ts` → `lens()`（相机远平面 300） |

**参数两组对照**（最后一轮我动了第二组，没截图确认；如果觉得不对，先改回第一组）：

| | 看过截图的一组 | 当前代码里的（未看过） |
|---|---|---|
| `BAND.squash` | 1.45 | 1.5 |
| `BAND.plate` | 4.8 × 4.0 × 0.24 | 4.4 × 3.7 × 0.24 |
| `RING_VIEW` | u 0.30 / v 0.53 / share 0.56 | u 0.285 / v 0.50 / share 0.50 |
| `HOLE.scale` | 1.95 | 2.1 |

改动原因：第一组截图里环的右叶尖会碰到右侧信息面板的文字，环底部碰到左下角的 "01 / 04" 页码，所以整体缩小约 10%、略左上移、板子变细让两个洞更大。

---

## 5. 验证情况（如实）

**做过的：**
- `npm run typecheck` ✔；`npm run build:web` ✔。
- 单元测试：`fin-band`(13)、`stage-layout`(8)、`regroup`、`choreography`、`row-track` 在最后一次改动后跑过，全过。其中 `fin-band` 验证了：八字曲线闭合且两股在交叉处错开、解析速度与差分一致、弧长等距、每片坐标系正交右手、**接缝处无突变**、扭转是奇数个半圈、档案卡过接缝姿态连续、洞口在左环内；`stage-layout` 验证整个环（含板角）在各种窗口比例下都在画面内且靠左、洞里的档案朝向镜头、行视图 1–6 号都在画面内、镜头是长焦。
- 浏览器（无头 Chromium + SwiftShader 软件渲染，1280×720、「高」档）：首页 ∞ 环（拼装中、静止）、首页→「模组」重组的两个中间帧（约 60% 和 90%）、模组行静止状态（肋状轨道 + 左边抽出的详情档案）截图看过，**控制台除一条 three.js 的 `PCFSoftShadowMap` 弃用警告外没有报错**。中间帧里薄片是边飞边翻滚的一团，选中的那张档案翻面时会有一瞬间是空白背面——这是设计（翻到一半才换面），但螺旋半径我觉得略大，可以收一点（`fin-mesh.ts` 里的 `swing`、`choreography.ts` 的 `flightOffset`）。
- 顺手发现并修了两个问题：模组行右半屏被纸色蒙住；详情档案上"作者"一行与标签重叠（`faces.ts`）。

**没做完的（请您重点看）：**
1. 上面第 4 节"未看过"的那组参数——没截图。
2. 详情档案"作者/标签不重叠"的修复——改了代码，没再截图。
3. 没逐项走：**滚轮转环**、**悬停显示信息面**、**分类切换动画**、**行→首页的反向重组**、**暗色主题**、**环的"详情"模式（右边旧的 DetailView）**。
4. 完整 `npm test` 没有在最后一次改动后跑完。
5. 性能没在真 GPU 上量过（SwiftShader 的耗时没有参考价值）。Electron / Windows 便携包没重新构建。

---

## 6. 已知问题 / 建议接手顺序

1. **先看首页环**（`npm run dev:demo` + `npm run dev`，`&debug` 切 `high`），对照您发的参考图调 `BAND` / `RING_VIEW`。参考图里洞更大、环带更窄、交叉处更斜，我这版更"紧"一点。
2. **环上的真实档案是"边缘朝向镜头的标签板"**，远看像白色小棍，信息读不出来。设想（**没做**）：鼠标悬停时该档案向镜头"翻开"，露出 3D 信息面；同时给拾取加"射线打到档案包围盒"的兜底，否则边缘朝向时很难点中。
3. 环形态下 `pointerParallax`（鼠标视差）没接。
4. 远端的薄片会被景深虚化（和参考图风格一致）；如果觉得糊，调 `scene.ts` 里 `finishFrame` 的光圈。
5. 阴影窗口放大到 ±23×±19 后，2048 阴影图的精度变低，薄片之间的细阴影可能不够细：可以把环形态的阴影图提到 4096，或者干脆关掉环的投影只留 AO。
6. `minimal` 档下薄片仍是 `MeshPhysicalMaterial`（clearcoat 0.12），可以降成 `MeshStandardMaterial`。
7. 本地 mod 管理仍在旧面板；没有舞台（WebGL 不可用）时回退到旧的浏览面板。

---

## 7. 许可与来源说明

- 您给的链接 `tmc5csxr9m-cpu/laiyin-video` 是 **AGPL-3.0-or-later**，且含《明日方舟》同人元素。我**只把它当视觉/思路参考**（约 400 片薄板沿 ∞ 曲线排开，可以在 ∞ / 行 / 墙 / 螺旋之间变形），**没有复制它的代码、着色器或素材**，本包里的环、材质、动画都是原创实现。如果以后想直接拿它的代码用，整个启动器就得按 AGPL 开源，请先想好。
- 前端基础仍是 RhineLabUI（MIT © LBEILC），许可文件沿用 `THIRD-PARTY-LICENSES.txt`。
- 后端没有使用 PCL2 源码；官方源 + BMCLAPI / MCIM 镜像的做法同前。
