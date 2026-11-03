import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createArchiveLighting } from "../../archive-lighting";
import { disposeThreeTree } from "../../three-resources";
import { rpc, tryRpc } from "../api";
import { guard, openLink } from "../actions";
import { $, debounce, html, safeUrl, setHtml } from "../dom";
import { formatBytes, formatCount, formatPercent, formatSpeed, loaderLabel, relativeTime } from "../format";
import { openDialog, openSheet, promptDialog, toast, type ModalHandle } from "../modal";
import { displayName, primaryLoader } from "../records";
import { store } from "../store";
import type { ContentKind, ContentProject, ContentSource, ContentVersion, InstanceSummary, TaskSnapshot } from "../types";
import "../../styles/browse-array.css";

/** Browse Modrinth / CurseForge as a Möbius archive ring. There is no second list page and no download sheet:
 *  project art, labels, progress and interaction all live on the archive surfaces. */

const KINDS: { id: ContentKind; label: string }[] = [
  { id: "modpack", label: "整合包" },
  { id: "mod", label: "模组" },
  { id: "resourcepack", label: "资源包" },
  { id: "shader", label: "光影" },
  { id: "datapack", label: "数据包" },
];

const SORTS: [string, string][] = [
  ["relevance", "相关度"],
  ["downloads", "下载量"],
  ["updated", "最近更新"],
  ["newest", "最新发布"],
];

const PAGE_SIZE = 20;
const MOBIUS_R = 11;
const MOBIUS_WIDTH = 4.8;
const MOBIUS_Y = 1.2;
const CARD_W = 2.94;
const CARD_H = 1.68;
const CARD_D = 0.14;
const LABEL_W = 2.8;
const LABEL_H = 1.6;
const FONT = 'MiSans, "Microsoft YaHei", "PingFang SC", sans-serif';

type DeckMode = "projects" | "versions";

interface DeckItem {
  key: string;
  project: ContentProject;
  version?: ContentVersion;
}

interface ContentCard {
  item: DeckItem;
  index: number;
  group: THREE.Group;
  body: THREE.Mesh;
  label: THREE.Mesh;
  labelMaterial: THREE.MeshBasicMaterial;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  u: number;
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  normal: THREE.Vector3;
  delay: number;
  hover: number;
  selected: number;
  icon?: HTMLImageElement | null;
  taskId?: string;
  task?: TaskSnapshot;
  alive: boolean;
}

interface FlatTarget {
  gameVersion?: string;
  loader?: string;
}

let open: ModalHandle | undefined;

export function openBrowse(options: { kind?: ContentKind; instanceId?: string; query?: string } = {}) {
  if (open) return;
  const sheet = openSheet({
    eyebrow: "BROWSE · MÖBIUS ARCHIVE",
    title: "莫比乌斯档案环",
  });
  sheet.root.classList.add("browse-array-sheet");
  open = sheet;
  let view: BrowseArrayView | undefined;
  try {
    view = new BrowseArrayView(sheet, options);
  } catch (error) {
    console.error("3D browse failed", error);
    sheet.body.innerHTML = `<div class="ba-fatal"><b>三维内容阵列无法启动</b><div>${String((error as Error)?.message ?? error)}</div></div>`;
  }
  void sheet.closed.then(() => {
    view?.dispose();
    if (open === sheet) open = undefined;
  });
}

class BrowseArrayView {
  private readonly state = {
    kind: "modpack" as ContentKind,
    source: "modrinth" as ContentSource,
    sort: "relevance" as "relevance" | "downloads" | "updated" | "newest",
    query: "",
    page: 0,
    total: 0,
    instanceId: undefined as string | undefined,
    anyVersion: false,
    curseforge: false,
    loading: false,
    mode: "projects" as DeckMode,
    selectedIndex: -1,
    lastLoad: 0,
  };

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(37, 16 / 9, 0.1, 160);
  private readonly deck = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpVec = new THREE.Vector3();
  private readonly pointer = new THREE.Vector2(0, 0);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly host: HTMLElement;
  private readonly bodyGeometry: RoundedBoxGeometry;
  private readonly labelGeometry: THREE.PlaneGeometry;
  private readonly glassMaterial: THREE.MeshPhysicalMaterial;
  private readonly cards: ContentCard[] = [];
  private readonly unsubscribers: (() => void)[] = [];
  private readonly cleanups: (() => void)[] = [];

  private projectItems: DeckItem[] = [];
  private versionItems: DeckItem[] = [];
  private currentProject?: ContentProject;
  private projectSelection = 0;
  private versionSelection = 0;
  private hoverIndex = -1;
  private pointerClient = { x: 0, y: 0 };
  private loadToken = 0;
  private searchAbort?: AbortController;
  private versionAbort?: AbortController;
  private lastFrame = performance.now();
  private clock = 0;
  private animationFrame = 0;
  private disposed = false;
  private pointerDown?: { id: number; x: number; y: number; moved: boolean; orbit: number; height: number };
  private orbitAngle = 0;
  private targetOrbitAngle = 0;
  private cameraHeight = 7.4;
  private targetCameraHeight = 7.4;
  private orbitRadius = 22;
  private resizeObserver?: ResizeObserver;
  private hintTimer = 0;

  private readonly searchInput: HTMLInputElement;
  private readonly kindsHost: HTMLElement;
  private readonly sourcesHost: HTMLElement;
  private readonly sortSelect: HTMLSelectElement;
  private readonly targetHost: HTMLElement;
  private readonly noticeHost: HTMLElement;
  private readonly statusHost: HTMLElement;
  private readonly tipHost: HTMLElement;
  private readonly countHost: HTMLElement;
  private readonly pageHost: HTMLElement;
  private readonly backButton: HTMLButtonElement;
  private readonly versionsButton: HTMLButtonElement;
  private readonly installButton: HTMLButtonElement;

  constructor(
    private readonly sheet: ModalHandle,
    options: { kind?: ContentKind; instanceId?: string; query?: string },
  ) {
    this.state.kind = options.kind && KINDS.some((entry) => entry.id === options.kind) ? options.kind : "modpack";
    this.state.instanceId = options.instanceId;
    this.state.query = options.query ?? "";

    this.sheet.body.innerHTML = `
      <div class="ba-host" data-ba="host">
        <div class="ba-hud">
          <div class="ba-bar">
            <div class="ba-seg" data-ba="kinds"></div>
            <label class="ba-search"><span aria-hidden="true">⌕</span><input data-ba="query" placeholder="搜索名称、作者或关键词" autocomplete="off" /></label>
            <div class="ba-seg" data-ba="sources"></div>
            <select class="ba-select" data-ba="sort">${SORTS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
          </div>
          <div class="ba-bar ba-bar-sub">
            <span class="ba-target" data-ba="target"></span>
            <span class="ba-grow"></span>
            <button class="ba-btn" data-ba="back" hidden>← 返回项目</button>
            <button class="ba-btn" data-ba="versions">版本 V</button>
            <button class="ba-btn accent" data-ba="install">安装 Enter</button>
          </div>
          <div class="ba-notice" data-ba="notice"></div>
        </div>
        <div class="ba-status" data-ba="status" hidden></div>
        <div class="ba-tip" data-ba="tip" hidden></div>
        <div class="ba-foot">
          <span data-ba="count"></span>
          <span class="ba-help">拖动环视 · 滚轮绕环切换 · 悬停查看 · 单击选中 · 再点打开版本</span>
          <span class="ba-pager"><button class="ba-btn" data-ba="prev">上一页</button><b data-ba="page"></b><button class="ba-btn" data-ba="next">下一页</button></span>
        </div>
      </div>`;

    this.host = this.q<HTMLElement>("host");
    this.searchInput = this.q<HTMLInputElement>("query");
    this.kindsHost = this.q<HTMLElement>("kinds");
    this.sourcesHost = this.q<HTMLElement>("sources");
    this.sortSelect = this.q<HTMLSelectElement>("sort");
    this.targetHost = this.q<HTMLElement>("target");
    this.noticeHost = this.q<HTMLElement>("notice");
    this.statusHost = this.q<HTMLElement>("status");
    this.tipHost = this.q<HTMLElement>("tip");
    this.countHost = this.q<HTMLElement>("count");
    this.pageHost = this.q<HTMLElement>("page");
    this.backButton = this.q<HTMLButtonElement>("back");
    this.versionsButton = this.q<HTMLButtonElement>("versions");
    this.installButton = this.q<HTMLButtonElement>("install");

    this.searchInput.value = this.state.query;
    this.sortSelect.value = this.state.sort;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setSize(Math.max(1, this.host.clientWidth), Math.max(1, this.host.clientHeight));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.className = "ba-canvas";
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("aria-label", "三维内容档案阵列");
    this.host.prepend(this.renderer.domElement);

    this.scene.background = new THREE.Color("#050b0d");
    this.scene.fog = new THREE.Fog("#050b0d", 26, 62);
    createArchiveLighting(this.renderer, this.scene);
    this.deck.position.y = MOBIUS_Y;
    this.scene.add(this.deck);
    this.addEnvironment();
    this.bodyGeometry = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, 4, 0.11);
    this.labelGeometry = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
    this.glassMaterial = new THREE.MeshPhysicalMaterial({
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
    this.camera.position.set(MOBIUS_R + 11, 7.4, 0);
    this.camera.lookAt(0, MOBIUS_Y, 0);

    this.wire();
    this.resize();
    this.animationFrame = requestAnimationFrame(this.animate);
    void this.boot();
  }

  private q<T extends HTMLElement>(name: string): T {
    return $(`[data-ba="${name}"]`, this.sheet.body);
  }

  /** Everything that makes the field read as a single physical ribbon rather than a flat grid. */
  private addEnvironment() {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(42, 96),
      new THREE.MeshStandardMaterial({ color: "#050c0e", roughness: 0.68, metalness: 0.16 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -5.6;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(6.5, 22, 96),
      new THREE.MeshBasicMaterial({ color: "#4fc397", transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -5.55;
    this.scene.add(halo);

    const grid = new THREE.GridHelper(84, 42, "#2b6656", "#102621");
    grid.position.y = -5.57;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    this.scene.add(grid);

    this.buildMobiusRibbon();
    this.buildDust();

    const cool = new THREE.PointLight("#63d6ad", 18, 42, 2);
    cool.position.set(0, 12, 0);
    this.scene.add(cool);
    const warm = new THREE.PointLight("#d6a66a", 12, 34, 2);
    warm.position.set(-12, 6, -9);
    this.scene.add(warm);
  }

  private mobiusPoint(u: number, v: number): THREE.Vector3 {
    const r = MOBIUS_R + v * Math.cos(u / 2);
    return new THREE.Vector3(r * Math.cos(u), v * Math.sin(u / 2), r * Math.sin(u));
  }

  private mobiusFrame(u: number): { position: THREE.Vector3; quaternion: THREE.Quaternion; normal: THREE.Vector3 } {
    const position = this.mobiusPoint(u, 0);
    const tangentU = new THREE.Vector3(-Math.sin(u), 0, Math.cos(u));
    const tangentV = new THREE.Vector3(Math.cos(u / 2) * Math.cos(u), Math.sin(u / 2), Math.cos(u / 2) * Math.sin(u)).normalize();
    const normal = new THREE.Vector3().crossVectors(tangentU, tangentV).normalize();
    this.tmpMatrix.makeBasis(tangentU, tangentV, normal);
    return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(this.tmpMatrix), normal };
  }

  private buildMobiusRibbon() {
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
        const v = ((j / vSegments) * 2 - 1) * MOBIUS_WIDTH / 2;
        const p = this.mobiusPoint(u, v);
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
    const ribbon = new THREE.Mesh(
      geometry,
      new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.33,
        roughness: 0.28,
        metalness: 0.18,
        clearcoat: 1,
        clearcoatRoughness: 0.24,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ribbon.name = "mobius-ribbon";
    this.deck.add(ribbon);

    const edgeMaterial = new THREE.LineBasicMaterial({ color: "#d9bb84", transparent: true, opacity: 0.5 });
    for (const side of [-1, 1]) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 360; i++) points.push(this.mobiusPoint((i / 360) * Math.PI * 2, side * MOBIUS_WIDTH / 2));
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      this.deck.add(new THREE.Line(geometry, edgeMaterial));
    }

    const centerPoints: THREE.Vector3[] = [];
    for (let i = 0; i <= 360; i++) centerPoints.push(this.mobiusPoint((i / 360) * Math.PI * 2, 0));
    this.deck.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(centerPoints),
      new THREE.LineBasicMaterial({ color: "#8ee0ba", transparent: true, opacity: 0.15 }),
    ));

    const ribPositions: number[] = [];
    for (let i = 0; i < 36; i++) {
      const u = (i / 36) * Math.PI * 2;
      for (const v of [-MOBIUS_WIDTH / 2, MOBIUS_WIDTH / 2]) {
        const point = this.mobiusPoint(u, v);
        ribPositions.push(point.x, point.y, point.z);
      }
    }
    const ribsGeometry = new THREE.BufferGeometry();
    ribsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(ribPositions, 3));
    this.deck.add(new THREE.LineSegments(
      ribsGeometry,
      new THREE.LineBasicMaterial({ color: "#71c7a2", transparent: true, opacity: 0.14 }),
    ));
  }

  private buildDust() {
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
    const dust = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: "#9de3c5",
      size: 0.045,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    dust.name = "archive-dust";
    this.scene.add(dust);
  }

  private async boot() {
    try {
      const status = await tryRpc("content.status");
      if (this.disposed) return;
      this.state.curseforge = Boolean(status?.curseforge);
      this.renderChrome();
      await document.fonts.ready.catch(() => undefined);
      if (!this.disposed) await this.search();
      for (const card of this.cards) this.paintCard(card);
    } catch (error) {
      if (!this.disposed) this.setStatus(`加载失败：${(error as Error).message}`);
    }
  }

  private wire() {
    this.sheet.body.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const kind = target.closest<HTMLElement>("[data-ba-kind]");
      if (kind?.dataset.baKind) {
        this.state.kind = kind.dataset.baKind as ContentKind;
        this.state.page = 0;
        this.state.mode = "projects";
        this.currentProject = undefined;
        this.renderChrome();
        void this.search();
        return;
      }
      const source = target.closest<HTMLElement>("[data-ba-source]");
      if (source?.dataset.baSource) {
        this.state.source = source.dataset.baSource as ContentSource;
        this.state.page = 0;
        this.renderChrome();
        void this.search();
        return;
      }
      if (target.closest("[data-ba='back']")) return this.backToProjects();
      if (target.closest("[data-ba='versions']")) return void this.openVersions();
      if (target.closest("[data-ba='install']")) return void this.installSelected();
      if (target.closest("[data-ba='prev']")) return this.changePage(-1);
      if (target.closest("[data-ba='next']")) return this.changePage(1);
      const link = target.closest<HTMLElement>("[data-ba-link]");
      if (link?.dataset.baLink) void openLink(link.dataset.baLink);
    });

    this.searchInput.addEventListener("input", debounce(() => {
      this.state.query = this.searchInput.value;
      this.state.page = 0;
      void this.search();
    }, 320));

    this.sortSelect.addEventListener("change", () => {
      this.state.sort = this.sortSelect.value as typeof this.state.sort;
      this.state.page = 0;
      void this.search();
    });

    this.targetHost.addEventListener("change", (event) => {
      const target = event.target as HTMLElement;
      if (target.matches("[data-ba-target-select]")) {
        this.state.instanceId = (target as HTMLSelectElement).value;
        this.state.page = 0;
        void this.search();
      } else if (target.matches("[data-ba-any]")) {
        this.state.anyVersion = (target as HTMLInputElement).checked;
        this.state.page = 0;
        void this.search();
      }
    });

    this.sheet.root.addEventListener("keydown", (event) => this.onKey(event));

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, orbit: this.targetOrbitAngle, height: this.targetCameraHeight };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.focus({ preventScroll: true });
      this.hideTip();
    });
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    canvas.addEventListener("pointercancel", () => { this.pointerDown = undefined; });
    canvas.addEventListener("pointerleave", () => {
      if (!this.pointerDown) {
        this.hoverIndex = -1;
        this.hideTip();
        this.pointer.set(0, 0);
      }
    });
    canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    const resize = () => this.resize();
    window.addEventListener("resize", resize);
    this.cleanups.push(() => window.removeEventListener("resize", resize));

    this.unsubscribers.push(store.on<TaskSnapshot>("task", (task) => this.syncTask(task)));
    this.unsubscribers.push(store.on("tasks", () => this.syncTasks()));
    this.unsubscribers.push(store.on("instances", () => this.renderTarget()));
    this.hintTimer = window.setInterval(() => this.syncTasks(), 1200);
    this.cleanups.push(() => clearInterval(this.hintTimer));
  }

  private onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (document.querySelector(".dialog")) return;
    if (event.key === "Escape") {
      if (this.state.mode === "versions") {
        event.preventDefault();
        event.stopPropagation();
        this.backToProjects();
      }
      return;
    }
    const current = this.state.selectedIndex < 0 ? 0 : this.state.selectedIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      if (this.cards.length) this.select((current + delta + this.cards.length) % this.cards.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void this.installSelected();
    } else if (event.key.toLowerCase() === "v" && this.state.mode === "projects") {
      event.preventDefault();
      void this.openVersions();
    } else if (event.key === "PageUp") {
      event.preventDefault();
      this.changePage(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      this.changePage(1);
    }
  }

  private onPointerMove(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerClient = { x: event.clientX, y: event.clientY };
    if (this.pointerDown) {
      const dx = event.clientX - this.pointerDown.x;
      const dy = event.clientY - this.pointerDown.y;
      if (Math.hypot(dx, dy) > 5) this.pointerDown.moved = true;
      if (this.pointerDown.moved) {
        this.targetOrbitAngle = this.pointerDown.orbit - dx * 0.006;
        this.targetCameraHeight = THREE.MathUtils.clamp(this.pointerDown.height + dy * 0.018, 3.1, 14.5);
        this.hideTip();
      }
      return;
    }
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.cards.map((card) => card.body), false)[0];
    const index = hit ? this.cards.findIndex((card) => card.body === hit.object) : -1;
    if (index === this.hoverIndex) {
      if (index >= 0) this.positionTip(event.clientX, event.clientY);
      return;
    }
    this.hoverIndex = index;
    this.renderer.domElement.style.cursor = index >= 0 ? "pointer" : "grab";
    if (index >= 0) this.showTip(this.cards[index], event.clientX, event.clientY); else this.hideTip();
  }

  private onPointerUp(event: PointerEvent) {
    const down = this.pointerDown;
    this.pointerDown = undefined;
    if (!down || down.id !== event.pointerId) return;
    if (!down.moved && this.hoverIndex >= 0) this.activate(this.hoverIndex);
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault();
    if (this.state.loading || !this.cards.length) return;
    if (event.shiftKey) {
      this.changePage(event.deltaY > 0 ? 1 : -1);
      return;
    }
    const direction = event.deltaY > 0 ? 1 : -1;
    const current = this.state.selectedIndex < 0 ? 0 : this.state.selectedIndex;
    this.select((current + direction + this.cards.length) % this.cards.length);
  }

  private activate(index: number) {
    if (index < 0 || index >= this.cards.length) return;
    if (this.state.mode === "versions") {
      const card = this.cards[index];
      void this.install(card.item.project, card.item.version);
      return;
    }
    if (this.state.selectedIndex === index) {
      void this.openVersions();
      return;
    }
    this.select(index);
  }

  private select(index: number) {
    if (index < 0 || index >= this.cards.length || index === this.state.selectedIndex) return;
    this.state.selectedIndex = index;
    if (this.state.mode === "projects") this.projectSelection = index;
    else this.versionSelection = index;
    for (const card of this.cards) this.paintCard(card);
    this.syncButtons();
    this.focusSelected();
    const card = this.cards[index];
    if (card) this.showTip(card, this.pointerClient.x || innerWidth / 2, this.pointerClient.y || innerHeight / 2);
  }

  private focusSelected(immediate = false) {
    const card = this.cards[this.state.selectedIndex];
    if (!card) return;
    let delta = card.u - this.targetOrbitAngle;
    delta = ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.targetOrbitAngle += delta;
    this.targetCameraHeight = 7.4;
    if (immediate) {
      this.orbitAngle = this.targetOrbitAngle;
      this.cameraHeight = this.targetCameraHeight;
    }
  }

  private async search() {
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    const mine = ++this.loadToken;
    this.state.loading = true;
    this.state.mode = "projects";
    this.currentProject = undefined;
    this.setStatus("正在检索档案…");
    this.renderChrome();
    if (this.state.source === "curseforge" && !this.state.curseforge) {
      this.state.loading = false;
      this.projectItems = [];
      this.state.total = 0;
      this.buildDeck([]);
      this.setStatus("CurseForge 需要 API 密钥。请在设置 → 账号与密钥中填写，或切换到 Modrinth。");
      return;
    }
    try {
      const result = await rpc("content.search", {
        source: this.state.source,
        kind: this.state.kind,
        query: this.state.query || undefined,
        sort: this.state.sort,
        page: this.state.page,
        pageSize: PAGE_SIZE,
        ...this.filters(),
      }, controller.signal);
      if (this.disposed || mine !== this.loadToken) return;
      this.projectItems = result.projects.map((project) => ({ key: `project:${project.id}`, project }));
      this.state.total = result.total;
      this.state.mode = "projects";
      this.state.selectedIndex = this.projectItems.length ? Math.min(this.projectSelection, this.projectItems.length - 1) : -1;
      this.buildDeck(this.projectItems);
      this.setStatus(this.projectItems.length ? "" : "没有找到匹配的档案。换个关键词，或取消版本过滤试试。");
    } catch (error) {
      if (this.disposed || mine !== this.loadToken || controller.signal.aborted) return;
      this.projectItems = [];
      this.state.total = 0;
      this.buildDeck([]);
      this.setStatus(`检索失败：${(error as Error).message}`);
    } finally {
      if (!this.disposed && mine === this.loadToken) {
        this.state.loading = false;
        this.renderChrome();
      }
    }
  }

  private async openVersions() {
    const card = this.cards[this.state.selectedIndex];
    if (!card || this.state.mode !== "projects") return;
    const project = card.item.project;
    this.projectSelection = this.state.selectedIndex;
    this.currentProject = project;
    this.versionAbort?.abort();
    const controller = new AbortController();
    this.versionAbort = controller;
    this.setStatus("正在读取版本档案…");
    try {
      const versions = await rpc("content.versions", {
        source: project.source,
        projectId: project.id,
        ...this.filters(),
      }, controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      this.state.mode = "versions";
      this.state.selectedIndex = versions.length ? Math.min(this.versionSelection, Math.min(versions.length, PAGE_SIZE) - 1) : -1;
      this.versionItems = versions.slice(0, PAGE_SIZE).map((version) => ({ key: `version:${project.id}:${version.id}`, project, version }));
      this.buildDeck(this.versionItems);
      this.sheet.setTitle("BROWSE · VERSIONS", project.title);
      this.setStatus(versions.length ? "" : "没有符合当前实例版本 / 加载器条件的版本。");
      this.renderChrome();
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        this.setStatus(`版本读取失败：${(error as Error).message}`);
      }
    }
  }

  private backToProjects() {
    if (this.state.mode !== "versions") return;
    this.state.mode = "projects";
    this.currentProject = undefined;
    this.state.selectedIndex = this.projectItems.length ? Math.min(this.projectSelection, this.projectItems.length - 1) : -1;
    this.buildDeck(this.projectItems);
    this.sheet.setTitle("BROWSE · MÖBIUS ARCHIVE", "莫比乌斯档案环");
    this.setStatus(this.projectItems.length ? "" : "没有找到匹配的档案。");
    this.renderChrome();
  }

  private changePage(delta: number) {
    if (this.state.mode !== "projects") return;
    const pages = Math.max(1, Math.ceil(this.state.total / PAGE_SIZE));
    const next = this.state.page + delta;
    if (next < 0 || next >= pages) return;
    this.state.page = next;
    this.state.selectedIndex = -1;
    void this.search();
  }

  private filters(): FlatTarget {
    const instance = this.state.kind === "modpack" || this.state.anyVersion ? undefined : this.instance();
    if (!instance) return {};
    return { gameVersion: instance.mcVersion, loader: this.state.kind === "mod" ? primaryLoader(instance)?.kind : undefined };
  }

  private instance(): InstanceSummary | undefined {
    return this.state.instanceId ? store.instance(this.state.instanceId) : undefined;
  }

  private buildDeck(items: DeckItem[]) {
    this.clearCards();
    if (!items.length) {
      this.state.selectedIndex = -1;
      this.syncButtons();
      this.syncFoot();
      return;
    }
    const now = performance.now();
    items.forEach((item, index) => {
      const u = (index / items.length) * Math.PI * 2;
      const frame = this.mobiusFrame(u);
      const group = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeometry, this.glassMaterial);
      body.renderOrder = 1;
      const canvas = document.createElement("canvas");
      canvas.width = 768;
      canvas.height = 440;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const labelMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, opacity: 0 });
      const label = new THREE.Mesh(this.labelGeometry, labelMaterial);
      label.position.z = CARD_D / 2 + 0.008;
      label.renderOrder = 2;
      const backLabel = new THREE.Mesh(this.labelGeometry, labelMaterial);
      backLabel.position.z = -CARD_D / 2 - 0.008;
      backLabel.rotation.y = Math.PI;
      backLabel.renderOrder = 2;
      group.add(body, label, backLabel);
      group.position.copy(frame.position).addScaledVector(frame.normal, 0.1);
      group.quaternion.copy(frame.quaternion);
      group.scale.setScalar(0.58);
      this.deck.add(group);
      const card: ContentCard = {
        item, index, group, body, label, labelMaterial, canvas, texture,
        u,
        basePosition: group.position.clone(),
        baseQuaternion: frame.quaternion.clone(),
        normal: frame.normal.clone(),
        delay: (now - this.lastFrame) / 1000 + index * 0.035,
        hover: 0,
        selected: 0,
        alive: true,
      };
      this.cards.push(card);
      this.paintCard(card);
      void this.loadIcon(card);
    });
    this.focusSelected(true);
    this.syncButtons();
    this.syncFoot();
  }

  private clearCards() {
    for (const card of this.cards) {
      card.alive = false;
      this.deck.remove(card.group);
      card.labelMaterial.dispose();
      card.texture.dispose();
    }
    this.cards.length = 0;
    this.hoverIndex = -1;
    this.hideTip();
  }

  private async loadIcon(card: ContentCard) {
    const url = safeUrl(card.item.project.iconUrl);
    if (!url) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
    if (!card.alive || !loaded || this.disposed) return;
    card.icon = loaded;
    this.paintCard(card);
  }

  private paintCard(card: ContentCard) {
    const ctx = card.canvas.getContext("2d");
    if (!ctx) return;
    const W = card.canvas.width;
    const H = card.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    roundRect(ctx, 4, 4, W - 8, H - 8, 24);
    ctx.clip();
    const background = ctx.createLinearGradient(0, 0, W, H);
    background.addColorStop(0, "rgba(13,25,25,.97)");
    background.addColorStop(0.62, "rgba(7,15,17,.98)");
    background.addColorStop(1, "rgba(4,9,11,.99)");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W * 0.7, H * 0.12, 10, W * 0.7, H * 0.12, W * 0.72);
    glow.addColorStop(0, "rgba(98,194,154,.14)");
    glow.addColorStop(1, "rgba(98,194,154,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(154,213,188,.05)";
    ctx.lineWidth = 1;
    for (let y = 0; y < H; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
    }
    const accent = card.item.version
      ? card.item.version.channel === "release" ? "#82d4a9" : card.item.version.channel === "beta" ? "#e0b06d" : "#dd8a74"
      : kindAccent(card.item.project.kind);
    ctx.fillStyle = accent;
    ctx.fillRect(28, 24, 62, 3);
    ctx.fillStyle = "rgba(224,244,233,.62)";
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText(card.item.version ? "VERSION ARCHIVE" : "CONTENT ARCHIVE", 28, 52);
    ctx.fillStyle = "rgba(143,186,167,.58)";
    ctx.font = `500 13px ${FONT}`;
    ctx.fillText(card.item.project.source === "curseforge" ? "CURSEFORGE" : "MODRINTH", W - 144, 52);
    ctx.fillStyle = "rgba(224,244,233,.55)";
    ctx.fillText(`X-${String(card.index + 1).padStart(3, "0")}`, W - 80, 74);

    const iconX = 28;
    const iconY = 82;
    const iconSize = 126;
    ctx.save();
    roundRect(ctx, iconX, iconY, iconSize, iconSize, 18);
    ctx.clip();
    if (card.icon) {
      drawCover(ctx, card.icon, iconX, iconY, iconSize, iconSize);
    } else {
      const fallback = ctx.createLinearGradient(iconX, iconY, iconX + iconSize, iconY + iconSize);
      fallback.addColorStop(0, "#24473b");
      fallback.addColorStop(1, "#091717");
      ctx.fillStyle = fallback;
      ctx.fillRect(iconX, iconY, iconSize, iconSize);
      ctx.fillStyle = "rgba(224,248,235,.78)";
      ctx.font = `700 54px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(String(card.item.project.title || "?").slice(0, 1).toUpperCase(), iconX + iconSize / 2, iconY + iconSize * 0.66);
      ctx.textAlign = "left";
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(166,226,200,.18)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, iconX, iconY, iconSize, iconSize, 18);
    ctx.stroke();

    const textX = 176;
    const textWidth = W - textX - 34;
    ctx.fillStyle = "#eef8f2";
    ctx.font = `700 31px ${FONT}`;
    const title = card.item.version ? card.item.version.name : card.item.project.title;
    const titleLines = wrapText(ctx, title, textWidth, 2);
    titleLines.forEach((line, index) => ctx.fillText(line, textX, 112 + index * 38));
    const author = card.item.project.author ? `by ${card.item.project.author}` : "未知作者";
    ctx.fillStyle = "rgba(161,202,186,.72)";
    ctx.font = `500 16px ${FONT}`;
    ctx.fillText(author, textX, 172);
    ctx.fillStyle = "rgba(199,223,212,.82)";
    ctx.font = `400 16px ${FONT}`;
    const summary = card.item.version
      ? [card.item.version.versionNumber, card.item.version.gameVersions.slice(0, 4).join(", "), card.item.version.loaders.map(loaderLabel).join(" / "), channelLabel(card.item.version.channel)].filter(Boolean).join(" · ")
      : stripTags(card.item.project.summary);
    const summaryLines = wrapText(ctx, summary, textWidth, 3);
    summaryLines.forEach((line, index) => ctx.fillText(line, textX, 206 + index * 23));

    const chips = card.item.version
      ? [...card.item.version.gameVersions.slice(0, 2), ...card.item.version.loaders.slice(0, 2).map(loaderLabel)]
      : card.item.project.categories.slice(0, 3);
    let chipX = 30;
    const chipY = H - 84;
    for (const chip of chips) {
      const label = String(chip);
      ctx.font = `500 13px ${FONT}`;
      const width = Math.min(176, ctx.measureText(label).width + 22);
      ctx.fillStyle = "rgba(101,184,149,.14)";
      roundRect(ctx, chipX, chipY, width, 26, 13);
      ctx.fill();
      ctx.fillStyle = "rgba(188,231,210,.9)";
      ctx.fillText(label, chipX + 11, chipY + 18);
      chipX += width + 7;
      if (chipX > W - 170) break;
    }
    ctx.fillStyle = "rgba(150,187,170,.68)";
    ctx.font = `500 13px ${FONT}`;
    const downloads = card.item.version ? card.item.version.downloads : card.item.project.downloads;
    const date = card.item.version ? card.item.version.publishedAt : card.item.project.updatedAt;
    ctx.fillText(`↓ ${formatCount(downloads)}${date ? `  ·  ${relativeTime(Date.parse(date))}` : ""}`, 30, H - 34);

    if (card.task) this.paintProgress(ctx, card.task, W, H);
    else if (card.taskId) this.paintProgress(ctx, { state: "queued", stages: [], warnings: [], title: "", id: card.taskId, kind: "content", createdAt: 0, stageLabel: "准备下载…" }, W, H);

    if (this.state.selectedIndex === card.index) {
      ctx.strokeStyle = "rgba(131,221,181,.78)";
      ctx.lineWidth = 2;
      roundRect(ctx, 4.5, 4.5, W - 9, H - 9, 24);
      ctx.stroke();
      ctx.fillStyle = "rgba(132,219,180,.84)";
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(this.state.mode === "projects" ? "再次点击 · 查看版本" : "点击 · 安装此版本", W - 30, H - 34);
      ctx.textAlign = "left";
    }
    ctx.restore();
    card.texture.needsUpdate = true;
  }

  private paintProgress(ctx: CanvasRenderingContext2D, task: TaskSnapshot, W: number, H: number) {
    const fraction = task.state === "done" ? 1 : Math.max(0, Math.min(1, task.fraction ?? 0));
    const running = task.state === "running" || task.state === "queued";
    ctx.fillStyle = task.state === "failed" ? "rgba(36,9,9,.92)" : "rgba(3,12,12,.9)";
    ctx.fillRect(0, H - 78, W, 78);
    ctx.fillStyle = task.state === "failed" ? "#e08778" : "#bce8d4";
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(task.state === "failed" ? "安装失败" : task.state === "done" ? "安装完成" : task.stageLabel || "正在安装…", 30, H - 48);
    ctx.fillStyle = "rgba(79,139,113,.28)";
    roundRect(ctx, 30, H - 34, W - 60, 9, 5);
    ctx.fill();
    ctx.fillStyle = task.state === "failed" ? "#c96f63" : "#71d3a6";
    roundRect(ctx, 30, H - 34, running ? Math.max(10, (W - 60) * fraction) : W - 60, 9, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(220,243,232,.72)";
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText(`${formatPercent(fraction, 0)}${task.progress?.speed ? `  ·  ${formatSpeed(task.progress.speed)}` : ""}${task.error ? `  ·  ${stripTags(task.error)}` : ""}`, 30, H - 14);
  }

  private syncTask(task: TaskSnapshot) {
    const card = this.cards.find((entry) => entry.taskId === task.id);
    if (!card) return;
    card.task = task;
    this.paintCard(card);
  }

  private syncTasks() {
    for (const card of this.cards) {
      if (!card.taskId) continue;
      const task = store.tasks.get(card.taskId);
      if (!task) continue;
      if (card.task === task) continue;
      card.task = task;
      this.paintCard(card);
    }
  }

  private async installSelected() {
    const card = this.cards[this.state.selectedIndex];
    if (!card) return;
    await this.install(card.item.project, card.item.version);
  }

  private async install(project: ContentProject, version?: ContentVersion) {
    if (project.kind === "modpack") {
      const suggested = project.title.replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 48) || "整合包";
      const name = await promptDialog({
        title: `安装整合包“${project.title}”`,
        label: "实例名称",
        value: suggested,
        confirm: "开始安装",
        message: version ? `版本：${version.name}` : "安装最新版本",
        validate: (value) => (!value ? "请输入名称" : store.instances.some((entry) => entry.name.toLowerCase() === value.toLowerCase()) ? "已经有同名的实例" : /[\\/:*?"<>|]/.test(value) ? "名称包含不能用于文件夹的字符" : undefined),
      });
      if (!name) return;
      const started = await guard(() => rpc("packs.installOnline", {
        source: project.source,
        projectId: project.id,
        versionId: version?.id,
        name,
        title: project.title,
      }));
      if (!started) return;
      this.bindTask(project.id, started.taskId);
      toast(`开始安装整合包 ${project.title}`, "ok");
      return;
    }

    const target = this.instance() ?? store.instances.find((entry) => entry.valid);
    if (!target) {
      toast("请先创建或选择一个实例", "error");
      return;
    }
    let world: string | undefined;
    if (project.kind === "datapack") {
      const worlds = await guard(() => rpc("worlds.list", { instanceId: target.id }));
      if (!worlds) return;
      if (!worlds.length) {
        toast("这个实例还没有存档，进游戏创建一个世界后才能安装数据包", "error");
        return;
      }
      world = await pickWorld(worlds.map((entry) => ({ folder: entry.folder, name: entry.name })));
      if (!world) return;
    }
    const filter = this.filters();
    const started = await guard(() => rpc("content.install", {
      instanceId: target.id,
      kind: project.kind as Exclude<ContentKind, "modpack">,
      source: project.source,
      projectId: project.id,
      versionId: version?.id,
      gameVersion: filter.gameVersion,
      loader: filter.loader,
      withDependencies: true,
      world,
      title: project.title,
    }));
    if (!started) return;
    this.bindTask(project.id, started.taskId);
    toast(`正在安装 ${project.title}（含前置依赖）`, "ok");
  }

  private bindTask(projectId: string, taskId: string) {
    const card = this.cards.find((entry) => entry.item.project.id === projectId);
    if (!card) return;
    card.taskId = taskId;
    card.task = store.tasks.get(taskId);
    this.paintCard(card);
  }

  private renderChrome() {
    const kinds = KINDS.map((entry) => html`<button data-ba-kind="${entry.id}" aria-pressed="${entry.id === this.state.kind}">${entry.label}</button>`);
    setHtml(this.kindsHost, html`${kinds}`);
    setHtml(this.sourcesHost, html`<button data-ba-source="modrinth" aria-pressed="${this.state.source === "modrinth"}">Modrinth</button><button data-ba-source="curseforge" aria-pressed="${this.state.source === "curseforge"}">CurseForge</button>`);
    this.sortSelect.value = this.state.sort;
    this.renderTarget();
    setHtml(this.noticeHost, this.state.source === "curseforge" && !this.state.curseforge
      ? html`<div class="ba-note">CurseForge 需要 API 密钥，请到 设置 → 账号与密钥 填写，或切换到 Modrinth。</div>`
      : html``);
    this.backButton.hidden = this.state.mode !== "versions";
    this.syncButtons();
    this.syncFoot();
  }

  private renderTarget() {
    const instances = store.instances.filter((entry) => entry.valid);
    if (this.state.kind === "modpack") {
      setHtml(this.targetHost, html`<span class="ba-chip">整合包会安装成新实例</span>`);
      return;
    }
    if (!this.state.instanceId || !store.instance(this.state.instanceId)) this.state.instanceId = instances[0]?.id;
    if (!instances.length) {
      setHtml(this.targetHost, html`<span class="ba-chip warn">请先创建实例</span>`);
      return;
    }
    setHtml(this.targetHost, html`<span class="ba-mini">安装到</span><select class="ba-select" data-ba-target-select>${instances.map((entry) => html`<option value="${entry.id}" ${entry.id === this.state.instanceId ? "selected" : ""}>${displayName(entry)} · ${entry.mcVersion ?? "?"}${primaryLoader(entry) ? ` · ${loaderLabel(primaryLoader(entry)!.kind)}` : ""}</option>`)}</select><label class="ba-check"><input type="checkbox" data-ba-any ${this.state.anyVersion ? "checked" : ""} />不限版本</label>`);
  }

  private syncButtons() {
    const card = this.cards[this.state.selectedIndex];
    const busy = card?.taskId ? store.tasks.get(card.taskId) : undefined;
    const working = busy?.state === "running" || busy?.state === "queued";
    this.versionsButton.disabled = !card || this.state.mode !== "projects" || this.state.loading;
    this.installButton.disabled = !card || this.state.loading || working;
    this.installButton.textContent = working ? "安装中…" : this.state.mode === "versions" ? "安装此版本" : "安装最新版";
    for (const button of this.sheet.body.querySelectorAll<HTMLButtonElement>("[data-ba-kind], [data-ba-source]")) {
      button.disabled = this.state.loading;
    }
  }

  private syncFoot() {
    const pages = Math.max(1, Math.ceil(this.state.total / PAGE_SIZE));
    this.countHost.textContent = this.state.mode === "versions"
      ? `版本档案 ${this.cards.length} 个`
      : this.state.total ? `共 ${formatCount(this.state.total)} 个内容` : this.state.loading ? "正在检索…" : "没有结果";
    this.pageHost.textContent = this.state.mode === "versions" ? "" : `${this.state.page + 1} / ${pages}`;
    this.q<HTMLButtonElement>("prev").disabled = this.state.mode !== "projects" || this.state.page <= 0;
    this.q<HTMLButtonElement>("next").disabled = this.state.mode !== "projects" || this.state.page + 1 >= pages;
  }

  private setStatus(message: string) {
    this.statusHost.hidden = !message;
    this.statusHost.textContent = message;
  }

  private showTip(card: ContentCard, x: number, y: number) {
    const project = card.item.project;
    const version = card.item.version;
    const categories = version ? [...version.gameVersions.slice(0, 3), ...version.loaders.slice(0, 3).map(loaderLabel)] : project.categories.slice(0, 4);
    const summary = version ? (version.changelog || "这个版本没有提供更新说明。") : project.summary;
    this.tipHost.hidden = false;
    setHtml(this.tipHost, html`
      <div class="ba-tip-kicker">${version ? "VERSION · " : ""}${project.source === "curseforge" ? "CURSEFORGE" : "MODRINTH"} · ${kindLabel(project.kind)}</div>
      <div class="ba-tip-title">${version ? version.name : project.title}</div>
      <div class="ba-tip-sub">${project.author ?? "未知作者"} · ↓ ${formatCount(version ? version.downloads : project.downloads)}${version ? ` · ${relativeTime(Date.parse(version.publishedAt))}` : project.updatedAt ? ` · ${relativeTime(Date.parse(project.updatedAt))}` : ""}</div>
      <div class="ba-tip-text">${stripTags(summary)}</div>
      <div class="ba-tip-chips">${categories.map((entry) => html`<span>${entry}</span>`)}</div>
      <div class="ba-tip-hint">${this.state.mode === "versions" ? "点击安装这个版本" : "单击选中 · 再次点击查看版本 · Enter 安装最新版"}${project.pageUrl ? html`<button class="ba-link" data-ba-link="${project.pageUrl}">打开页面 ↗</button>` : ""}</div>`);
    this.positionTip(x, y);
  }

  private positionTip(x: number, y: number) {
    if (this.tipHost.hidden) return;
    const width = this.tipHost.offsetWidth || 320;
    const height = this.tipHost.offsetHeight || 160;
    this.tipHost.style.transform = `translate3d(${Math.max(12, Math.min(innerWidth - width - 12, x + 18))}px, ${Math.max(12, Math.min(innerHeight - height - 12, y + 18))}px, 0)`;
  }

  private hideTip() {
    this.tipHost.hidden = true;
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.fov = this.camera.aspect < 1.1 ? 48 : this.camera.aspect < 1.45 ? 42 : 37;
    this.orbitRadius = this.camera.aspect < 1.1 ? 28 : this.camera.aspect < 1.45 ? 25 : 22;
    this.camera.updateProjectionMatrix();
  }

  private animate = (time: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.05, Math.max(0, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    this.clock += dt;
    const smooth = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
    const phaseDrift = this.cards.length && this.state.selectedIndex < 0 && !this.pointerDown ? dt * 0.04 : 0;
    this.targetOrbitAngle += phaseDrift;
    this.orbitAngle += (this.targetOrbitAngle - this.orbitAngle) * smooth;
    this.cameraHeight += (this.targetCameraHeight - this.cameraHeight) * smooth;
    const selected = this.cards[this.state.selectedIndex];
    const focus = selected
      ? selected.basePosition.clone().add(this.deck.position)
      : new THREE.Vector3(0, MOBIUS_Y, 0);
    focus.y += 0.15;
    const orbit = this.orbitAngle + (this.reducedMotion ? 0 : this.pointer.x * 0.015);
    const cameraTarget = new THREE.Vector3(
      Math.cos(orbit) * this.orbitRadius,
      this.cameraHeight + (this.reducedMotion ? 0 : this.pointer.y * 0.08),
      Math.sin(orbit) * this.orbitRadius,
    );
    this.camera.position.lerp(cameraTarget, smooth);
    this.camera.lookAt(focus);
    const up = new THREE.Vector3(0, 1, 0);
    const worldPos = new THREE.Vector3();
    for (const card of this.cards) {
      if (!card.alive) continue;
      card.delay = Math.max(0, card.delay - dt);
      const appear = Math.min(1, Math.max(0, (this.clock - card.delay) / 0.62));
      const eased = 1 - Math.pow(1 - appear, 3);
      const isHover = this.hoverIndex === card.index;
      const isSelected = this.state.selectedIndex === card.index;
      card.hover += ((isHover ? 1 : 0) - card.hover) * smooth;
      card.selected += ((isSelected ? 1 : 0) - card.selected) * smooth;
      const wave = this.reducedMotion ? 0 : Math.sin(this.clock * 0.7 + card.u * 2.2) * 0.022;
      const lift = card.hover * 0.09 + card.selected * 0.28 + wave;
      const targetPos = card.basePosition.clone().addScaledVector(card.normal, 0.08 + lift);
      targetPos.y += card.selected * 0.18;
      if (eased < 1) targetPos.lerp(new THREE.Vector3(0, 0, 0), 1 - eased);
      card.group.position.lerp(targetPos, smooth);
      if (isSelected) {
        worldPos.copy(card.group.position).add(this.deck.position);
        const zAxis = cameraTarget.clone().sub(worldPos);
        if (zAxis.lengthSq() < 0.0001) zAxis.copy(card.normal);
        zAxis.normalize();
        const xAxis = new THREE.Vector3().crossVectors(up, zAxis);
        if (xAxis.lengthSq() < 0.0001) xAxis.set(1, 0, 0);
        xAxis.normalize();
        const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
        this.tmpMatrix.makeBasis(xAxis, yAxis, zAxis);
        this.tmpQuat.setFromRotationMatrix(this.tmpMatrix);
        card.group.quaternion.slerp(this.tmpQuat, smooth);
      } else {
        card.group.quaternion.slerp(card.baseQuaternion, smooth);
      }
      const targetScale = 0.58 + eased * 0.42 + card.hover * 0.035 + card.selected * 0.2;
      card.group.scale.setScalar(THREE.MathUtils.lerp(card.group.scale.x, targetScale, smooth));
      card.labelMaterial.opacity += (eased - card.labelMaterial.opacity) * smooth;
    }
    const dust = this.scene.getObjectByName("archive-dust");
    if (dust && !this.reducedMotion) dust.rotation.y += dt * 0.012;
    this.scene.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private get reducedMotion() {
    const motion = store.ready ? store.settings.ui.motion : "auto";
    return motion === "reduced" || (motion === "auto" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    clearInterval(this.hintTimer);
    this.searchAbort?.abort();
    this.versionAbort?.abort();
    this.resizeObserver?.disconnect();
    for (const cleanup of this.cleanups) cleanup();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.clearCards();
    disposeThreeTree(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function kindLabel(kind: ContentKind): string {
  return KINDS.find((entry) => entry.id === kind)?.label ?? kind;
}

function kindAccent(kind: ContentKind): string {
  return { modpack: "#82d4a9", mod: "#a9d89a", resourcepack: "#8bb9df", shader: "#d8b886", datapack: "#c89bd9" }[kind];
}

function channelLabel(channel: ContentVersion["channel"]): string {
  return { release: "正式版", beta: "测试版", alpha: "早期版" }[channel];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
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

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const chars = Array.from(text.trim());
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

function drawCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const scale = Math.max(width / iw, height / ih);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, width, height);
}

function pickWorld(worlds: { folder: string; name: string }[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = openDialog({
      eyebrow: "DATA PACK",
      title: "安装到哪个世界？",
      size: "narrow",
      body: html`<div class="list">${worlds.map((world) => html`<button class="pick" data-world="${world.folder}"><span class="grow">${world.name}</span><span class="muted mono" style="font-size:11px">${world.folder}</span></button>`)}</div>`,
      buttons: [{ id: "cancel", label: "取消" }],
    });
    dialog.root.addEventListener("click", (event) => {
      const pick = (event.target as HTMLElement).closest<HTMLElement>("[data-world]");
      if (!pick) return;
      resolve(pick.dataset.world);
      dialog.finishWith("picked");
    });
    void dialog.result.then(() => resolve(undefined));
  });
}
