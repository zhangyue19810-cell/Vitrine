import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import "./style.css";

/**
 * Standalone extraction of the Vitrine browse field.
 * The data is local demo content; the geometry, interaction and surface painting are the shipped
 * Möbius archive implementation without the Electron/core transport.
 */

const RING_RADIUS = 11;
const RING_WIDTH = 4.8;
const RING_Y = 1.2;
const CARD_W = 2.94;
const CARD_H = 1.68;
const CARD_D = 0.14;
const LABEL_W = 2.8;
const LABEL_H = 1.6;
const FONT = 'MiSans, "Microsoft YaHei", "PingFang SC", sans-serif';

interface Project {
  id: string;
  title: string;
  author: string;
  summary: string;
  categories: string[];
  downloads: number;
  kind: "模组" | "光影" | "资源包" | "整合包";
  accent: string;
  icon: HTMLCanvasElement;
}

interface Card {
  project: Project;
  index: number;
  group: THREE.Group;
  body: THREE.Mesh;
  labelMaterial: THREE.MeshBasicMaterial;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  u: number;
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  normal: THREE.Vector3;
  hover: number;
  selected: number;
  appear: number;
  progress?: number;
  progressTimer?: number;
}

const projects: Project[] = [
  ["机械动力：齿轮与天空", "Create Studio", "用齿轮、传动轴与天空岛重建一条完整的机械生产线。", ["科技", "整合包", "NeoForge"], 1284000, "整合包", "#8ed8b3"],
  ["Iris Shaders", "Iris Team", "为 Fabric 与 NeoForge 带来现代光影加载和极高的帧率。", ["光影", "Fabric", "优化"], 8430000, "光影", "#89bedf"],
  ["Sodium", "CaffeineMC", "重写渲染管线，让 Minecraft 在高分辨率下保持顺滑。", ["优化", "Fabric", "NeoForge"], 11260000, "模组", "#b0d99b"],
  ["Complementary Reimagined", "EminGT", "明亮、干净且保留原版色彩语言的光影包。", ["光影", "Iris", "推荐"], 3920000, "光影", "#e3bd7c"],
  ["Terralith", "Starmute", "用原版方块生成更丰富、更奇异的生物群系。", ["世界生成", "数据包", "推荐"], 2850000, "模组", "#97c9c4"],
  ["Fresh Animations", "FreshLX", "给每只生物增加更自然、更有辨识度的动画。", ["装饰", "动画", "资源包"], 2440000, "资源包", "#d4a5d4"],
  ["Distant Horizons", "James Seibel", "在视野尽头继续绘制地形，让世界真正延伸到远方。", ["优化", "远景", "Fabric"], 1740000, "模组", "#83b8e4"],
  ["Xaero's Minimap", "Xaero", "轻量、稳定、功能完整的小地图与路径点系统。", ["地图", "冒险", "实用"], 3010000, "模组", "#b8d28f"],
  ["JEI", "mezz", "物品配方与用途查询，是几乎所有整合包的基础设施。", ["实用", "配方", "NeoForge"], 4780000, "模组", "#d3b988"],
  ["Farmer's Delight", "vectorwing", "为农场与厨房添加一整套温暖的烹饪与种植内容。", ["农业", "食物", "装饰"], 1250000, "模组", "#b7d48d"],
  ["Sophisticated Backpacks", "P3pp3rF1y", "可升级、可染色、可自动整理的模块化背包。", ["实用", "存储", "Forge"], 980000, "模组", "#d6a77d"],
  ["Better Combat", "ZsoltMolnarrr", "重新设计近战动作、攻击节奏与武器挥动。", ["战斗", "动画", "Fabric"], 760000, "模组", "#d29286"],
  ["BSL Shaders", "capttatsu", "柔和体积光、自然色调与高质量水面反射。", ["光影", "OptiFine", "Iris"], 2180000, "光影", "#8bcad4"],
  ["Continuity", "Pepperbell", "为 Fabric 提供连接纹理和原版风格材质增强。", ["资源包", "优化", "Fabric"], 520000, "资源包", "#c9b8de"],
  ["Physics Mod", "Haubna", "让方块、生物和布娃娃拥有真实而克制的物理反馈。", ["物理", "视觉", "Fabric"], 640000, "模组", "#9ab8e2"],
  ["Chunky", "pop4959", "预渲染区块，让地图、截图和服务器世界更完整。", ["工具", "渲染", "服务器"], 410000, "模组", "#a4d6be"],
  ["Mod Menu", "Prospector", "在游戏内查看、配置和管理已安装的模组。", ["实用", "Fabric", "管理"], 1130000, "模组", "#bdd79e"],
  ["Nature's Spirit", "Team Spirit", "为森林、河流与湿地补充更自然的植物层次。", ["自然", "装饰", "资源包"], 350000, "资源包", "#a2c991"],
  ["Create: Astral", "Astral Team", "把机械动力、探索与一套完整的进度系统放进同一个世界。", ["整合包", "冒险", "科技"], 710000, "整合包", "#d4b887"],
  ["Complementary Unbound", "EminGT", "更自由、更具电影感的光影预设，适合风景与建筑。", ["光影", "Iris", "电影感"], 1940000, "光影", "#e0c38f"],
].map((entry, index) => ({
  id: `demo-${index}`,
  title: entry[0] as string,
  author: entry[1] as string,
  summary: entry[2] as string,
  categories: entry[3] as string[],
  downloads: entry[4] as number,
  kind: entry[5] as Project["kind"],
  accent: entry[6] as string,
  icon: makeIcon(entry[0] as string, entry[5] as string, entry[6] as string, index),
}));

const app = document.querySelector<HTMLElement>("#app")!;
const sceneHost = document.querySelector<HTMLElement>("#scene")!;
const tip = document.querySelector<HTMLElement>("[data-tip]")!;
const status = document.querySelector<HTMLElement>("[data-status]")!;
const countHost = document.querySelector<HTMLElement>("[data-count]")!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setSize(sceneHost.clientWidth, sceneHost.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute("aria-label", "Vitrine 莫比乌斯档案环");
sceneHost.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#050b0d");
scene.fog = new THREE.Fog("#050b0d", 26, 62);
const camera = new THREE.PerspectiveCamera(37, sceneHost.clientWidth / sceneHost.clientHeight, 0.1, 160);
camera.position.set(RING_RADIUS + 11, 7.4, 0);
camera.lookAt(0, RING_Y, 0);

const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(room, 0.04).texture;
scene.environmentIntensity = 0.56;
room.dispose();
pmrem.dispose();
const hemisphere = new THREE.HemisphereLight("#fff8ee", "#20312f", 0.9);
const key = new THREE.DirectionalLight("#fff3e5", 2.2);
key.position.set(-12, 18, 8);
const cool = new THREE.PointLight("#64d6ae", 22, 44, 2);
cool.position.set(0, 12, 0);
const warm = new THREE.PointLight("#d3a36b", 14, 34, 2);
warm.position.set(-12, 6, -9);
scene.add(hemisphere, key, cool, warm);

const ring = new THREE.Group();
ring.position.y = RING_Y;
scene.add(ring);

buildFloor();
buildRibbon();
buildDust();

const bodyGeometry = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, 4, 0.11);
const labelGeometry = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
const glass = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color("#9bd8bd"),
  roughness: 0.13,
  metalness: 0.04,
  transparent: true,
  opacity: 0.14,
  clearcoat: 1,
  clearcoatRoughness: 0.14,
  envMapIntensity: 1.5,
  side: THREE.DoubleSide,
  depthWrite: false,
});

const cards: Card[] = [];
for (const [index, project] of projects.entries()) {
  const u = (index / projects.length) * Math.PI * 2;
  const frame = mobiusFrame(u);
  const group = new THREE.Group();
  const body = new THREE.Mesh(bodyGeometry, glass);
  body.renderOrder = 1;
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 440;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const labelMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 });
  const front = new THREE.Mesh(labelGeometry, labelMaterial);
  front.position.z = CARD_D / 2 + 0.008;
  front.renderOrder = 2;
  const back = new THREE.Mesh(labelGeometry, labelMaterial);
  back.position.z = -CARD_D / 2 - 0.008;
  back.rotation.y = Math.PI;
  back.renderOrder = 2;
  group.add(body, front, back);
  group.position.copy(frame.position).addScaledVector(frame.normal, 0.1);
  group.quaternion.copy(frame.quaternion);
  group.scale.setScalar(0.58);
  ring.add(group);
  const card: Card = {
    project, index, group, body, labelMaterial, canvas, texture,
    u, basePosition: group.position.clone(), baseQuaternion: frame.quaternion.clone(), normal: frame.normal.clone(),
    hover: 0, selected: 0, appear: Math.min(1, index / 20),
  };
  cards.push(card);
  paintCard(card);
}

let selectedIndex = 0;
let hoverIndex = -1;
let orbitAngle = projects[0] ? 0 : 0;
let targetOrbitAngle = 0;
let cameraHeight = 7.4;
let targetCameraHeight = 7.4;
let orbitRadius = 22;
let pointer = new THREE.Vector2(0, 0);
let pointerClient = { x: 0, y: 0 };
let pointerDown: { id: number; x: number; y: number; moved: boolean; orbit: number; height: number } | undefined;
let lastClick = { index: -1, time: 0 };
let lastFrame = performance.now();
let clock = 0;
let animationFrame = 0;
let lastTooltipIndex = -1;
const raycaster = new THREE.Raycaster();
const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
countHost.textContent = `${projects.length} 个内容档案`;
focusSelected(true);

const canvas = renderer.domElement;
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointerleave", () => {
  if (!pointerDown) {
    hoverIndex = -1;
    hideTip();
    pointer.set(0, 0);
  }
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (!cards.length) return;
  const direction = event.deltaY > 0 ? 1 : -1;
  select((selectedIndex + direction + cards.length) % cards.length);
}, { passive: false });
window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    select((selectedIndex + 1) % cards.length);
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    select((selectedIndex - 1 + cards.length) % cards.length);
  } else if (event.key === "Enter") {
    event.preventDefault();
    simulateDownload(cards[selectedIndex]);
  }
});
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(sceneHost);
resize();
animationFrame = requestAnimationFrame(animate);
await document.fonts.ready.catch(() => undefined);
for (const card of cards) paintCard(card);
renderer.domElement.focus({ preventScroll: true });
setTimeout(() => {
  status.hidden = false;
  status.textContent = "单击档案聚焦 · 双击模拟下载进度 · 拖动鼠标环视";
  setTimeout(() => (status.hidden = true), 4200);
}, 500);

// ------------------------------------------------------------------------------------------------ Möbius geometry

function mobiusPoint(u: number, v: number) {
  const r = RING_RADIUS + v * Math.cos(u / 2);
  return new THREE.Vector3(r * Math.cos(u), v * Math.sin(u / 2), r * Math.sin(u));
}

function mobiusFrame(u: number) {
  const position = mobiusPoint(u, 0);
  const tangentU = new THREE.Vector3(-Math.sin(u), 0, Math.cos(u));
  const tangentV = new THREE.Vector3(Math.cos(u / 2) * Math.cos(u), Math.sin(u / 2), Math.cos(u / 2) * Math.sin(u)).normalize();
  const normal = new THREE.Vector3().crossVectors(tangentU, tangentV).normalize();
  tmpMatrix.makeBasis(tangentU, tangentV, normal);
  return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(tmpMatrix), normal };
}

function buildFloor() {
  const floor = new THREE.Mesh(new THREE.CircleGeometry(42, 96), new THREE.MeshStandardMaterial({ color: "#050c0e", roughness: 0.68, metalness: 0.16 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -5.6;
  scene.add(floor);
  const halo = new THREE.Mesh(new THREE.RingGeometry(6.5, 22, 96), new THREE.MeshBasicMaterial({ color: "#4fc397", transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }));
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -5.55;
  scene.add(halo);
  const grid = new THREE.GridHelper(84, 42, "#2b6656", "#102621");
  grid.position.y = -5.57;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.3;
  scene.add(grid);
}

function buildRibbon() {
  const uSegments = 280;
  const vSegments = 6;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const teal = new THREE.Color("#2d8b70");
  const gold = new THREE.Color("#c6a56b");
  for (let i = 0; i <= uSegments; i++) {
    const u = (i / uSegments) * Math.PI * 2;
    for (let j = 0; j <= vSegments; j++) {
      const v = ((j / vSegments) * 2 - 1) * RING_WIDTH / 2;
      const p = mobiusPoint(u, v);
      positions.push(p.x, p.y, p.z);
      const c = teal.clone().lerp(gold, 0.08 + 0.32 * (0.5 + 0.5 * Math.sin(u / 2)));
      colors.push(c.r, c.g, c.b);
    }
  }
  const stride = vSegments + 1;
  for (let i = 0; i < uSegments; i++) {
    for (let j = 0; j < vSegments; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  ring.add(new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.33,
    roughness: 0.28,
    metalness: 0.18,
    clearcoat: 1,
    clearcoatRoughness: 0.24,
    side: THREE.DoubleSide,
    depthWrite: false,
  })));
  const edgeMaterial = new THREE.LineBasicMaterial({ color: "#d9bb84", transparent: true, opacity: 0.5 });
  for (const side of [-1, 1]) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 360; i++) points.push(mobiusPoint((i / 360) * Math.PI * 2, side * RING_WIDTH / 2));
    ring.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), edgeMaterial));
  }
  const center: THREE.Vector3[] = [];
  for (let i = 0; i <= 360; i++) center.push(mobiusPoint((i / 360) * Math.PI * 2, 0));
  ring.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(center), new THREE.LineBasicMaterial({ color: "#8ee0ba", transparent: true, opacity: 0.15 })));
  const ribs: number[] = [];
  for (let i = 0; i < 36; i++) {
    const u = (i / 36) * Math.PI * 2;
    for (const v of [-RING_WIDTH / 2, RING_WIDTH / 2]) {
      const p = mobiusPoint(u, v);
      ribs.push(p.x, p.y, p.z);
    }
  }
  const ribGeometry = new THREE.BufferGeometry();
  ribGeometry.setAttribute("position", new THREE.Float32BufferAttribute(ribs, 3));
  ring.add(new THREE.LineSegments(ribGeometry, new THREE.LineBasicMaterial({ color: "#71c7a2", transparent: true, opacity: 0.14 })));
}

function buildDust() {
  const count = 180;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 7 + Math.random() * 28;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = -2 + Math.random() * 13;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const dust = new THREE.Points(geometry, new THREE.PointsMaterial({ color: "#9de3c5", size: 0.045, transparent: true, opacity: 0.36, depthWrite: false, sizeAttenuation: true }));
  dust.name = "dust";
  scene.add(dust);
}

// ------------------------------------------------------------------------------------------------ labels

function paintCard(card: Card) {
  const ctx = card.canvas.getContext("2d");
  if (!ctx) return;
  const W = card.canvas.width;
  const H = card.canvas.height;
  const project = card.project;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  roundRect(ctx, 4, 4, W - 8, H - 8, 24);
  ctx.clip();
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "rgba(13,26,25,.98)");
  bg.addColorStop(0.62, "rgba(7,15,17,.99)");
  bg.addColorStop(1, "rgba(4,9,11,1)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.72, H * 0.12, 8, W * 0.72, H * 0.12, W * 0.72);
  glow.addColorStop(0, hexA(project.accent, 0.14));
  glow.addColorStop(1, hexA(project.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(154,213,188,.05)";
  for (let y = 0; y < H; y += 30) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = project.accent;
  ctx.fillRect(28, 24, 62, 3);
  ctx.fillStyle = "rgba(224,244,233,.62)";
  ctx.font = `600 16px ${FONT}`;
  ctx.fillText("CONTENT ARCHIVE", 28, 52);
  ctx.fillStyle = "rgba(143,186,167,.58)";
  ctx.font = `500 13px ${FONT}`;
  ctx.fillText("MODRINTH", W - 124, 52);
  ctx.fillText(`X-${String(card.index + 1).padStart(3, "0")}`, W - 80, 74);
  const iconX = 28;
  const iconY = 82;
  const iconSize = 126;
  ctx.save();
  roundRect(ctx, iconX, iconY, iconSize, iconSize, 18);
  ctx.clip();
  ctx.drawImage(project.icon, iconX, iconY, iconSize, iconSize);
  ctx.restore();
  ctx.strokeStyle = "rgba(166,226,200,.18)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, iconX, iconY, iconSize, iconSize, 18);
  ctx.stroke();
  const textX = 176;
  const textWidth = W - textX - 34;
  ctx.fillStyle = "#eef8f2";
  ctx.font = `700 31px ${FONT}`;
  const titleLines = wrapText(ctx, project.title, textWidth, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, textX, 112 + i * 38));
  ctx.fillStyle = "rgba(161,202,186,.72)";
  ctx.font = `500 16px ${FONT}`;
  ctx.fillText(`by ${project.author}`, textX, 172);
  ctx.fillStyle = "rgba(199,223,212,.82)";
  ctx.font = `400 16px ${FONT}`;
  const summaryLines = wrapText(ctx, project.summary, textWidth, 3);
  summaryLines.forEach((line, i) => ctx.fillText(line, textX, 206 + i * 23));
  let chipX = 30;
  const chipY = H - 84;
  for (const chip of project.categories.slice(0, 3)) {
    ctx.font = `500 13px ${FONT}`;
    const width = Math.min(176, ctx.measureText(chip).width + 22);
    ctx.fillStyle = hexA(project.accent, 0.15);
    roundRect(ctx, chipX, chipY, width, 26, 13);
    ctx.fill();
    ctx.fillStyle = "rgba(188,231,210,.9)";
    ctx.fillText(chip, chipX + 11, chipY + 18);
    chipX += width + 7;
  }
  ctx.fillStyle = "rgba(150,187,170,.68)";
  ctx.font = `500 13px ${FONT}`;
  ctx.fillText(`↓ ${formatCount(project.downloads)}  ·  ${project.kind}`, 30, H - 34);
  if (card.progress !== undefined) {
    const fraction = Math.max(0, Math.min(1, card.progress));
    ctx.fillStyle = "rgba(3,12,12,.92)";
    ctx.fillRect(0, H - 78, W, 78);
    ctx.fillStyle = "#bce8d4";
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(fraction >= 1 ? "模拟下载完成" : "正在下载内容文件…", 30, H - 48);
    ctx.fillStyle = "rgba(79,139,113,.28)";
    roundRect(ctx, 30, H - 34, W - 60, 9, 5);
    ctx.fill();
    ctx.fillStyle = "#71d3a6";
    roundRect(ctx, 30, H - 34, Math.max(10, (W - 60) * fraction), 9, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(220,243,232,.72)";
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText(`${Math.round(fraction * 100)}% · ${formatSpeed(220000 + Math.sin(fraction * 9) * 60000)}`, 30, H - 14);
  }
  if (card.index === selectedIndex) {
    ctx.strokeStyle = "rgba(131,221,181,.8)";
    ctx.lineWidth = 2;
    roundRect(ctx, 4.5, 4.5, W - 9, H - 9, 24);
    ctx.stroke();
    ctx.fillStyle = "rgba(132,219,180,.84)";
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText("已聚焦 · 双击模拟下载", W - 30, H - 34);
    ctx.textAlign = "left";
  }
  ctx.restore();
  card.texture.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------------ animation

function animate(time: number) {
  const dt = Math.min(0.05, Math.max(0, (time - lastFrame) / 1000));
  lastFrame = time;
  clock += dt;
  const smooth = reduced.matches ? 1 : 1 - Math.exp(-dt * 6);
  orbitAngle += (targetOrbitAngle - orbitAngle) * smooth;
  cameraHeight += (targetCameraHeight - cameraHeight) * smooth;
  const selected = cards[selectedIndex];
  const focus = selected ? selected.basePosition.clone().add(ring.position) : new THREE.Vector3(0, RING_Y, 0);
  focus.y += 0.15;
  const orbit = orbitAngle + (reduced.matches ? 0 : pointer.x * 0.014);
  const cameraTarget = new THREE.Vector3(Math.cos(orbit) * orbitRadius, cameraHeight + (reduced.matches ? 0 : pointer.y * 0.08), Math.sin(orbit) * orbitRadius);
  camera.position.lerp(cameraTarget, smooth);
  camera.lookAt(focus);
  const up = new THREE.Vector3(0, 1, 0);
  const worldPos = new THREE.Vector3();
  for (const card of cards) {
    card.appear = Math.min(1, card.appear + dt * 0.75);
    const appear = 1 - Math.pow(1 - card.appear, 3);
    const isHover = hoverIndex === card.index;
    const isSelected = selectedIndex === card.index;
    card.hover += ((isHover ? 1 : 0) - card.hover) * smooth;
    card.selected += ((isSelected ? 1 : 0) - card.selected) * smooth;
    const wave = reduced.matches ? 0 : Math.sin(clock * 0.7 + card.u * 2.2) * 0.022;
    const targetPos = card.basePosition.clone().addScaledVector(card.normal, 0.08 + card.hover * 0.09 + card.selected * 0.28 + wave);
    targetPos.y += card.selected * 0.18;
    if (appear < 1) targetPos.lerp(new THREE.Vector3(0, 0, 0), 1 - appear);
    card.group.position.lerp(targetPos, smooth);
    if (isSelected) {
      worldPos.copy(card.group.position).add(ring.position);
      const zAxis = cameraTarget.clone().sub(worldPos);
      if (zAxis.lengthSq() < 0.0001) zAxis.copy(card.normal);
      zAxis.normalize();
      const xAxis = new THREE.Vector3().crossVectors(up, zAxis);
      if (xAxis.lengthSq() < 0.0001) xAxis.set(1, 0, 0);
      xAxis.normalize();
      const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
      tmpMatrix.makeBasis(xAxis, yAxis, zAxis);
      tmpQuat.setFromRotationMatrix(tmpMatrix);
      card.group.quaternion.slerp(tmpQuat, smooth);
    } else {
      card.group.quaternion.slerp(card.baseQuaternion, smooth);
    }
    const targetScale = 0.58 + appear * 0.42 + card.hover * 0.035 + card.selected * 0.2;
    card.group.scale.setScalar(THREE.MathUtils.lerp(card.group.scale.x, targetScale, smooth));
    card.labelMaterial.opacity += (appear - card.labelMaterial.opacity) * smooth;
  }
  const dust = scene.getObjectByName("dust");
  if (dust && !reduced.matches) dust.rotation.y += dt * 0.012;
  scene.updateMatrixWorld(true);
  renderer.render(scene, camera);
  animationFrame = requestAnimationFrame(animate);
}

function select(index: number) {
  if (index < 0 || index >= cards.length || index === selectedIndex) return;
  selectedIndex = index;
  for (const card of cards) paintCard(card);
  focusSelected();
  showStatus(`已聚焦：${cards[index].project.title}`);
}

function focusSelected(immediate = false) {
  const card = cards[selectedIndex];
  if (!card) return;
  let delta = card.u - targetOrbitAngle;
  delta = ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  targetOrbitAngle += delta;
  targetCameraHeight = 7.4;
  if (immediate) {
    orbitAngle = targetOrbitAngle;
    cameraHeight = targetCameraHeight;
  }
}

function simulateDownload(card: Card | undefined) {
  if (!card) return;
  if (card.progressTimer) window.clearInterval(card.progressTimer);
  card.progress = 0;
  paintCard(card);
  showStatus(`正在模拟下载：${card.project.title}`);
  card.progressTimer = window.setInterval(() => {
    card.progress = Math.min(1, (card.progress ?? 0) + 0.035);
    paintCard(card);
    if ((card.progress ?? 0) >= 1) {
      window.clearInterval(card.progressTimer);
      card.progressTimer = undefined;
      showStatus(`模拟下载完成：${card.project.title}`);
      window.setTimeout(() => paintCard(card), 1400);
    }
  }, 90);
}

// ------------------------------------------------------------------------------------------------ input

function onPointerMove(event: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  pointerClient = { x: event.clientX, y: event.clientY };
  if (pointerDown) {
    const dx = event.clientX - pointerDown.x;
    const dy = event.clientY - pointerDown.y;
    if (Math.hypot(dx, dy) > 5) pointerDown.moved = true;
    if (pointerDown.moved) {
      targetOrbitAngle = pointerDown.orbit - dx * 0.006;
      targetCameraHeight = THREE.MathUtils.clamp(pointerDown.height + dy * 0.018, 3.1, 14.5);
      hideTip();
    }
    return;
  }
  scene.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(cards.map((card) => card.body), false)[0];
  const index = hit ? cards.findIndex((card) => card.body === hit.object) : -1;
  if (index === hoverIndex) {
    if (index >= 0) positionTip(event.clientX, event.clientY);
    return;
  }
  hoverIndex = index;
  renderer.domElement.style.cursor = index >= 0 ? "pointer" : "grab";
  if (index >= 0) {
    lastTooltipIndex = index;
    showTip(cards[index].project, event.clientX, event.clientY);
  } else {
    lastTooltipIndex = -1;
    hideTip();
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, orbit: targetOrbitAngle, height: targetCameraHeight };
  renderer.domElement.setPointerCapture?.(event.pointerId);
  renderer.domElement.focus({ preventScroll: true });
  hideTip();
}

function onPointerUp(event: PointerEvent) {
  const down = pointerDown;
  pointerDown = undefined;
  if (!down || down.id !== event.pointerId || down.moved) return;
  if (hoverIndex < 0) return;
  const now = performance.now();
  if (lastClick.index === hoverIndex && now - lastClick.time < 340) {
    simulateDownload(cards[hoverIndex]);
    lastClick = { index: -1, time: 0 };
  } else {
    select(hoverIndex);
    lastClick = { index: hoverIndex, time: now };
  }
}

function showTip(project: Project, x: number, y: number) {
  tip.hidden = false;
  tip.innerHTML = `<div class="tip-kicker">MODRINTH · ${escapeHtml(project.kind)}</div>
    <div class="tip-title">${escapeHtml(project.title)}</div>
    <div class="tip-sub">by ${escapeHtml(project.author)} · ↓ ${formatCount(project.downloads)}</div>
    <div class="tip-text">${escapeHtml(project.summary)}</div>
    <div class="tip-tags">${project.categories.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
    <div class="tip-hint">单击聚焦 · 双击在档案表面模拟下载 · 拖动环视 · 滚轮切档</div>`;
  positionTip(x, y);
}
function positionTip(x: number, y: number) {
  if (tip.hidden) return;
  const width = tip.offsetWidth || 330;
  const height = tip.offsetHeight || 160;
  tip.style.transform = `translate3d(${Math.max(12, Math.min(innerWidth - width - 12, x + 18))}px, ${Math.max(12, Math.min(innerHeight - height - 12, y + 18))}px, 0)`;
}
function hideTip() {
  tip.hidden = true;
}
function showStatus(message: string) {
  status.hidden = false;
  status.textContent = message;
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => (status.hidden = true), 3200);
}
namespace showStatus { export let timer = 0; }

function resize() {
  const width = Math.max(1, sceneHost.clientWidth);
  const height = Math.max(1, sceneHost.clientHeight);
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.fov = camera.aspect < 1.1 ? 48 : camera.aspect < 1.45 ? 42 : 37;
  orbitRadius = camera.aspect < 1.1 ? 28 : camera.aspect < 1.45 ? 25 : 22;
  camera.updateProjectionMatrix();
}

window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationFrame);
  renderer.dispose();
});

// ------------------------------------------------------------------------------------------------ helpers

function makeIcon(title: string, kind: string, accent: string, seed: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const background = ctx.createLinearGradient(0, 0, 256, 256);
  background.addColorStop(0, "#0d2521");
  background.addColorStop(1, "#07100f");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 256, 256);
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < 11; i++) {
    const x = (seed * 37 + i * 53) % 256;
    const y = (seed * 61 + i * 29) % 256;
    const radius = 16 + ((seed + i * 7) % 58);
    ctx.strokeStyle = hexA(i % 3 === 0 ? accent : i % 3 === 1 ? "#b9e4d1" : "#d5b77d", 0.13 + (i % 4) * 0.06);
    ctx.lineWidth = 2 + (i % 3);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = hexA(accent, 0.2);
  ctx.fillRect(22, 188, 212, 1);
  ctx.fillStyle = "#eef8f2";
  ctx.font = `700 72px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(Array.from(title)[0] ?? "?", 128, 143);
  ctx.font = `600 12px ${FONT}`;
  ctx.fillStyle = "rgba(215,240,227,.6)";
  ctx.fillText(kind.toUpperCase(), 128, 173);
  ctx.textAlign = "left";
  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const chars = Array.from(text);
  const lines: string[] = [];
  let line = "";
  for (const char of chars) {
    if (ctx.measureText(line + char).width > maxWidth && line) {
      lines.push(line);
      line = char;
      if (lines.length >= maxLines) break;
    } else line += char;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length >= maxLines && chars.join("").length > lines.join("").length) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
  }
  return lines;
}
function formatCount(value: number) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 1_000_000 ? 0 : 1)} 万`;
  return String(Math.round(value));
}
function formatSpeed(value: number) {
  return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
}
function hexA(hex: string, alpha: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
