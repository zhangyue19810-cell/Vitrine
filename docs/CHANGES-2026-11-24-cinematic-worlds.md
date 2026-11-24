# 2026-11-24 — 电影感世界照片栏与交错页面动画

## 主界面世界照片栏

首页、下载页、实例详情与音乐页共享同一套空间氛围，但 Minecraft 照片栏**只在主界面出现**：

- `src/world-carousel.ts` 管理 8 张 Minecraft 实机截图；照片围绕固定视角排成曲面环，但任意时刻只显示当前一张完整照片和左右各半张，不把截图拉成包满全窗口的壁纸。
- 照片使用带横向弧度的曲面几何、深色包边和暖金细描边；一侧光源略强，两侧照片仍可辨认。
- 轮换是每 10 秒一次、约 1.6 秒阻尼过渡；中间照片滑出、下一张滑入，形成 3D 展示栏，而不是生硬换图。
- 照片栏渲染到透明离屏纹理，再作为主场景最底层的无深度图层合成：莫比乌斯环、档案卡和所有界面永远在照片前面，照片外的空间保留为真正的三维暗场。
- 主界面额外有一盏只在照片栏可见时开启的暖金轮廓光，帮助黑色金属环从照片中分离；离开主界面后灯和照片栏一起关闭。
- WebGL 不可用时，`src/app/world-backdrop.ts` 用 DOM 版三卡栏（中间完整、两侧半张）提供同样 10 秒轮换和低动态回退，而不是全屏壁纸。

素材为 8 张 Minecraft 实机截图（Xbox México / Wikimedia Commons，CC BY 3.0），已完成裁切、缩放和调色。完整来源和许可见 `public/assets/worlds/NOTICE.txt` 与 `NOTICE`。

## 页面与启动动效

- 页面切换：场景、旧页与新页同时经过 `filter: blur()` 高斯失焦；失焦属性在 420ms 后撤掉，页面内容继续完成交错动画。
- 主层级元素每 100ms 错开入场；面板内部子项以更短的 38–60ms 间隔跟进。元素从下方 17px、轻微缩小和模糊状态向上弹入，带一个很小的回弹过冲。
- 启动 splash 结束后，品牌、导航、页签、主卡、计数器、方向控制、底部信息栏从各自方向平滑淡入。
- 主玻璃面板响应指针产生 `perspective + rotateX/rotateY` 微倾斜；离开后用阻尼回正。
- 主要卡片、弹窗、底栏与设置面板通过 `MutationObserver` 动态挂上渐变描边；描边沿边缘缓慢流动，悬停时提亮加速，避免为每个卡片常驻一套高开销动画。
- `scene-aura`、`world-backdrop` 和背景光照使用多层模糊径向光与缓慢漂移，维持“照片栏存在于一个暗色空间里”的纵深感。
- 所有新增动效都提供 `prefers-reduced-motion` 和应用内“减少动态效果”回退；关闭动效时照片栏停在当前照片。

## 素材与许可

- `public/assets/worlds/world-01-mountains.jpg`
- `world-02-deep-dark.jpg`
- `world-03-end-city.jpg`
- `world-04-frozen-ocean.jpg`
- `world-05-jungle.jpg`
- `world-06-nether.jpg`
- `world-07-taiga.jpg`
- `world-08-diamonds.jpg`

均为 CC BY 3.0，来源页面列在 `public/assets/worlds/NOTICE.txt`。Minecraft 是 Mojang Synergies AB / Microsoft 的商标；本项目与其无隶属或背书关系。
