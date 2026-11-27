import {
  LinearFilter,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";

/**
 * Live interface glass.
 *
 * All glass surfaces are rendered by one shared Three.js shader from a static
 * background board (CSS paper / wallpaper, never the UI or the Möbius ring).
 * There is no page capture and no glass layer is ever hidden for a screenshot.
 * The board is only regenerated on resize, wallpaper or theme changes.
 */

const GLASS_TARGETS = [
  ".system-nav", ".view-tabs", ".callout", ".detail-panel", ".dl-bar",
  ".sheet", ".dialog", ".card", ".dl-flat-card",
  ".stat", ".setting", ".mod-row", ".mod-update-row", ".material-option",
  ".hud-left", ".hud-capsule", ".hud-queue", ".hud-float", ".item", ".empty", ".logview",
  ".settings-nav", ".menu", ".together-room", ".toast", ".launch-card", ".version-row", ".pick",
].join(",");

const MAX_SURFACES = 48;
const PIXEL_RATIO_CAP = 1;
const RENDER_DIMENSION_CAP = 1100;
const LAYER_CLASS = "liquid-shader-layer";
const TINT_CLASS = "liquid-shader-tint";
const HOST_CLASS = "liquid-shader-host";

/** Kept for callers that used to wait for a capture; the board is always ready. */
export function prepareGlassFrame(): Promise<void> {
  return Promise.resolve();
}

/** Last accepted tuner values (reference 300×200 surface). */
const GLASS = {
  thickness: 122,
  bezel: 44,
  ior: 2.34,
  scale: 2,
  blur: 0,
  specular: 0.18,
  tint: 0,
} as const;

export interface GlassTuning {
  thickness: number;
  bezel: number;
  ior: number;
  scale: number;
  blur: number;
  specular: number;
  tint: number;
  innerBlur: number;
  innerSpread: number;
  outerBlur: number;
  outerOpacity: number;
}

let tuningHook: ((patch: Partial<GlassTuning>) => void) | undefined;

/** Live-update all mounted glass surfaces (used by the in-app Y-key tuner). */
export function updateGlassTuning(patch: Partial<GlassTuning>): void {
  tuningHook?.(patch);
}

interface GlassSurface {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  tint: HTMLSpanElement;
  context: CanvasRenderingContext2D;
  pointer: Vector2;
  pointerActive: boolean;
  addedPosition: boolean;
  originalPosition: string;
  width: number;
  height: number;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform vec2 uViewport;
  uniform vec2 uSize;
  uniform vec4 uRect;
  uniform vec2 uPointer;
  uniform float uPointerActive;
  uniform float uRadius;
  uniform float uBezel;
  uniform float uThickness;
  uniform float uIOR;
  uniform float uScale;
  uniform float uBlur;
  uniform float uSpecular;
  uniform float uBody;
  uniform float uEdge;
  uniform float uLift;
  uniform float uTint;
  uniform float uDim;
  uniform float uTime;
  varying vec2 vUv;

  float sdRoundedRect(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  float surfaceHeight(float t) {
    float s = 1.0 - t;
    return pow(1.0 - s * s * s * s, 0.25);
  }

  vec3 sampleBg(vec2 uv) {
    return texture2D(uScene, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
  }

  vec3 sampleSoft(vec2 uv, float radius) {
    if (radius < 0.5) return sampleBg(uv);
    vec2 px = vec2(radius) / max(uViewport, vec2(1.0));
    vec2 offsets[16];
    offsets[0]  = vec2(-0.94201, -0.39906);
    offsets[1]  = vec2( 0.94558, -0.76890);
    offsets[2]  = vec2(-0.09418, -0.92938);
    offsets[3]  = vec2( 0.34495,  0.29387);
    offsets[4]  = vec2(-0.91588, -0.45771);
    offsets[5]  = vec2(-0.81544,  0.48568);
    offsets[6]  = vec2(-0.38277, -0.56071);
    offsets[7]  = vec2(-0.12675,  0.84686);
    offsets[8]  = vec2( 0.89642,  0.41254);
    offsets[9]  = vec2( 0.18150, -0.30020);
    offsets[10] = vec2(-0.01445, -0.16001);
    offsets[11] = vec2( 0.59614,  0.71118);
    offsets[12] = vec2( 0.49742, -0.47280);
    offsets[13] = vec2( 0.80685,  0.04588);
    offsets[14] = vec2(-0.32490, -0.03965);
    offsets[15] = vec2(-0.60975,  0.06566);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 16; i++) sum += sampleBg(uv + offsets[i] * px);
    return sum / 16.0;
  }

  void main() {
    vec2 localPx = (vUv - 0.5) * uSize;
    vec2 halfSize = uSize * 0.5;
    float sd = sdRoundedRect(localPx, halfSize, uRadius);
    if (sd > 1.25) discard;

    float alpha = 1.0 - smoothstep(-1.0, 1.25, sd);
    float distFromEdge = max(0.0, -sd);
    float bezel = max(1.0, min(uBezel, min(uRadius, min(halfSize.x, halfSize.y)) - 1.0));
    float t = clamp(distFromEdge / bezel, 0.0, 1.0);
    float h = surfaceHeight(t);
    float h2 = surfaceHeight(min(t + 0.001, 1.0));
    float dh = (h2 - h) / 0.001;

    float slopeAngle = atan(dh * (uThickness / bezel));
    float sinR = clamp(sin(slopeAngle) / uIOR, -1.0, 1.0);
    float thetaR = asin(sinR);
    float displacement = h * uThickness * (tan(slopeAngle) - tan(thetaR));

    float eps = 0.5;
    vec2 grad;
    grad.x = sdRoundedRect(localPx + vec2(eps, 0.0), halfSize, uRadius) - sd;
    grad.y = sdRoundedRect(localPx + vec2(0.0, eps), halfSize, uRadius) - sd;
    grad = normalize(grad);

    vec2 offset = -grad * displacement / max(uViewport, vec2(1.0)) * uScale;
    vec2 screenUv = vec2(
      (uRect.x + vUv.x * uRect.z) / uViewport.x,
      1.0 - (uRect.y + (1.0 - vUv.y) * uRect.w) / uViewport.y
    );
    vec3 colour = sampleSoft(screenUv + offset, uBlur);
    colour = mix(colour, vec3(1.0), uLift);

    vec2 lightDir = normalize(vec2(0.5, -0.7));
    float rim = 1.0 - smoothstep(0.0, bezel, distFromEdge);
    float rimDot = abs(dot(grad, lightDir));
    float highlight = pow(rimDot * rim, 1.35);
    colour += vec3(highlight * uSpecular * 0.42);
    float innerRim = smoothstep(0.0, 2.0, distFromEdge) * (1.0 - smoothstep(2.0, 6.0, distFromEdge));
    colour += vec3(innerRim * uSpecular * 0.08);

    colour *= 1.0 - uDim;
    colour = mix(colour, vec3(1.0), uTint);
    // Clear centre, visible refracted rim: the live page below must remain
    // visible through the glass instead of being covered by an opaque board.
    float edgeBand = 1.0 - smoothstep(0.0, max(1.0, bezel), distFromEdge);
    gl_FragColor = vec4(colour, alpha * (uBody + edgeBand * uEdge));
  }
`;

function borderRadius(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const values = style.borderTopLeftRadius.split(/[ /]/).map(Number.parseFloat).filter(Number.isFinite);
  const rect = element.getBoundingClientRect();
  return Math.max(2, Math.min(values[0] ?? 18, rect.width * 0.5, rect.height * 0.5));
}

function visible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 12 || rect.height < 12 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.02;
}

function makeSurface(element: HTMLElement): GlassSurface {
  const addedPosition = getComputedStyle(element).position === "static";
  const originalPosition = element.style.position;
  element.classList.add(HOST_CLASS);
  if (addedPosition) element.style.position = "relative";
  const canvas = document.createElement("canvas");
  canvas.className = LAYER_CLASS;
  canvas.setAttribute("aria-hidden", "true");
  canvas.tabIndex = -1;
  element.prepend(canvas);
  const tint = document.createElement("span");
  tint.className = TINT_CLASS;
  tint.setAttribute("aria-hidden", "true");
  element.append(tint);
  const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!context) {
    tint.remove();
    canvas.remove();
    element.classList.remove(HOST_CLASS);
    if (addedPosition) element.style.position = originalPosition;
    throw new Error("Canvas 2D is unavailable for the glass surface.");
  }
  return { element, canvas, tint, context, pointer: new Vector2(0.5, 0.5), pointerActive: false, addedPosition, originalPosition, width: 0, height: 0 };
}

export function installLiquidGlass(root: HTMLElement): () => void {
  const rendererCanvas = document.createElement("canvas");
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas: rendererCanvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
  } catch (error) {
    console.warn("Vitrine liquid glass: WebGL is unavailable; using transparent surfaces.", error);
    return () => undefined;
  }

  renderer.setPixelRatio(1);
  renderer.setSize(1, 1, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;

  const scene = new Scene();
  const camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 2);
  camera.position.z = 1;
  const uniforms = {
    uScene: { value: null as Texture | null },
    uViewport: { value: new Vector2(innerWidth, innerHeight) },
    uSize: { value: new Vector2(1, 1) },
    uRect: { value: new Vector4(0, 0, 1, 1) },
    uPointer: { value: new Vector2(0.5, 0.5) },
    uPointerActive: { value: 0 },
    uRadius: { value: 18 },
    uBezel: { value: Number(GLASS.bezel) },
    uThickness: { value: Number(GLASS.thickness) },
    uIOR: { value: Number(GLASS.ior) },
    uScale: { value: Number(GLASS.scale) },
    uBlur: { value: Number(GLASS.blur) },
    uSpecular: { value: Number(GLASS.specular) },
    uBody: { value: 0.14 },
    uEdge: { value: 0.46 },
    uLift: { value: 0.02 },
    uTime: { value: 0 },
    uTint: { value: Number(GLASS.tint) },
    uDim: { value: 0 },
  };
  const params: GlassTuning = {
    thickness: GLASS.thickness,
    bezel: GLASS.bezel,
    ior: GLASS.ior,
    scale: GLASS.scale,
    blur: GLASS.blur,
    specular: GLASS.specular,
    tint: GLASS.tint,
    innerBlur: 20,
    innerSpread: -5,
    outerBlur: 24,
    outerOpacity: 0.18,
  };

  const material = new ShaderMaterial({
    uniforms: uniforms as never,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const plane = new Mesh(new PlaneGeometry(1, 1), material);
  scene.add(plane);

  const surfaces = new Map<HTMLElement, GlassSurface>();
  const releaseSurface = (surface: GlassSurface) => {
    surface.canvas.remove();
    surface.tint.remove();
    surface.element.classList.remove(HOST_CLASS);
    delete surface.element.dataset.glassReady;
    if (surface.addedPosition) surface.element.style.position = surface.originalPosition;
  };
  let snapshotTexture: Texture | null = null;
  let sceneTexture: Texture | null = null;
  let frozenSceneTexture: Texture | null = null;
  const frozenSceneCanvas = document.createElement("canvas");
  let renderFrame = 0;
  let renderAll = true;
  let disposed = false;
  let pointerTarget: GlassSurface | null = null;
  const dirtySurfaces = new Set<GlassSurface>();
  const diagnostics = { renderCalls: 0, candidates: 0, dirty: 0, ready: 0, surfaces: 0, unreadyVisible: 0, scans: 0, matched: 0, added: 0, error: "" };
  (window as unknown as { __vitrineGlassDiagnostics?: unknown }).__vitrineGlassDiagnostics = diagnostics;

  // A fully transparent fallback board. Large surfaces sample the live 3D
  // scene instead; the board never adds a paper/white overlay of its own.
  const emptyCanvas = document.createElement("canvas");
  emptyCanvas.width = 1;
  emptyCanvas.height = 1;
  const emptyTexture = new Texture(emptyCanvas);
  emptyTexture.colorSpace = SRGBColorSpace;
  emptyTexture.magFilter = LinearFilter;
  emptyTexture.minFilter = LinearFilter;
  emptyTexture.generateMipmaps = false;
  emptyTexture.needsUpdate = true;
  snapshotTexture = emptyTexture;
  uniforms.uScene.value = emptyTexture;

  const liveSceneSurface = (element: HTMLElement) =>
    element.matches(".callout, .dl-bar, .launch-card, .detail-panel, .sheet, .dialog");

  const getSceneTexture = (): Texture | null => {
    const canvas = root.querySelector<HTMLCanvasElement>(".three-scene canvas");
    if (!canvas) return null;
    if (!sceneTexture || sceneTexture.image !== canvas) {
      sceneTexture?.dispose();
      sceneTexture = new Texture(canvas);
      sceneTexture.colorSpace = SRGBColorSpace;
      sceneTexture.magFilter = LinearFilter;
      sceneTexture.minFilter = LinearFilter;
      sceneTexture.generateMipmaps = false;
    }
    return sceneTexture;
  };

  const freezeSceneForModal = () => {
    const canvas = root.querySelector<HTMLCanvasElement>(".three-scene canvas");
    if (!canvas || !canvas.width || !canvas.height) return;
    frozenSceneCanvas.width = canvas.width;
    frozenSceneCanvas.height = canvas.height;
    const context = frozenSceneCanvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, frozenSceneCanvas.width, frozenSceneCanvas.height);
    context.drawImage(canvas, 0, 0);
    frozenSceneTexture?.dispose();
    frozenSceneTexture = new Texture(frozenSceneCanvas);
    frozenSceneTexture.colorSpace = SRGBColorSpace;
    frozenSceneTexture.magFilter = LinearFilter;
    frozenSceneTexture.minFilter = LinearFilter;
    frozenSceneTexture.generateMipmaps = false;
    frozenSceneTexture.needsUpdate = true;
    for (const surface of surfaces.values()) {
      if (surface.element.closest("#modal-root")) dirtySurfaces.add(surface);
    }
    if (dirtySurfaces.size) scheduleRender(false);
  };

  const renderSurfaces = () => {
    renderFrame = 0;
    diagnostics.renderCalls++;
    if (disposed || !snapshotTexture) return;
    const viewportWidth = Math.max(1, innerWidth);
    const viewportHeight = Math.max(1, innerHeight);
    uniforms.uViewport.value.set(viewportWidth, viewportHeight);
    const now = performance.now();
    uniforms.uTime.value = now * 0.001;
    const wantsAll = renderAll;
    const dirtyCandidates = [...dirtySurfaces].filter((surface) => visible(surface.element));
    // Newly opened sheets and their settings rows must get the next available
    // frames. Previously an all-surface refresh could keep them waiting behind
    // home glass, which is why the sidebar updated while adjacent rows stayed
    // on their old CSS fallback.
    const candidates = dirtyCandidates.length
      ? dirtyCandidates
      : wantsAll
        ? [...surfaces.values()].filter((surface) => visible(surface.element)).sort((a, b) => {
            const ar = a.element.getBoundingClientRect();
            const br = b.element.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
          }).slice(0, MAX_SURFACES)
        : [];
    diagnostics.candidates = candidates.length;
    diagnostics.dirty = dirtySurfaces.size;
    if (!dirtyCandidates.length) renderAll = false;
    dirtySurfaces.clear();
    // Spread newly revealed views across several frames. Music/download views
    // can add 20+ surfaces at once; rendering them all in one frame caused the
    // one-second hitch after switching.
    const BATCH = 6;
    const batch = candidates.slice(0, BATCH);
    for (const pending of candidates.slice(BATCH)) dirtySurfaces.add(pending);

    for (const surface of batch) {
      const rect = surface.element.getBoundingClientRect();
      const ratio = Math.min(
        PIXEL_RATIO_CAP,
        Math.max(1, devicePixelRatio || 1),
        RENDER_DIMENSION_CAP / Math.max(1, rect.width, rect.height),
      );
      const width = Math.max(1, Math.min(4096, Math.round(rect.width * ratio)));
      const height = Math.max(1, Math.min(4096, Math.round(rect.height * ratio)));
      if (surface.canvas.width !== width || surface.canvas.height !== height) {
        surface.canvas.width = width;
        surface.canvas.height = height;
        surface.width = width;
        surface.height = height;
      }
      surface.canvas.style.width = "100%";
      surface.canvas.style.height = "100%";
      uniforms.uRect.value.set(rect.left * ratio, rect.top * ratio, rect.width * ratio, rect.height * ratio);
      uniforms.uViewport.value.set(viewportWidth * ratio, viewportHeight * ratio);
      const inModal = Boolean(surface.element.closest("#modal-root"));
      const useScene = Boolean(sceneTexture) && liveSceneSurface(surface.element);
      uniforms.uScene.value = inModal
        ? (frozenSceneTexture ?? sceneTexture ?? snapshotTexture)
        : (useScene ? sceneTexture : snapshotTexture);
      uniforms.uSize.value.set(width, height);
      const minDim = Math.min(rect.width, rect.height);
      uniforms.uRadius.value = borderRadius(surface.element) * ratio;
      uniforms.uBezel.value = Math.min(params.bezel, Math.max(8, minDim * 0.18)) * ratio;
      uniforms.uThickness.value = Math.min(params.thickness, Math.max(10, minDim * 0.27));
      uniforms.uIOR.value = params.ior;
      uniforms.uScale.value = params.scale;
      const sheet = surface.element.matches(".sheet, .dialog");
      const detail = surface.element.matches(".detail-panel");
      const callout = surface.element.matches(".callout");
      const major = surface.element.matches(".settings-nav, .menu, .card, .launch-card, .dl-bar, .hud-left, .hud-capsule");
      uniforms.uBlur.value = (sheet ? 14 : detail ? 10 : callout ? 6 : 0) + params.blur;
      uniforms.uSpecular.value = params.specular;
      uniforms.uTint.value = params.tint;
      uniforms.uDim.value = sheet ? 0.16 : detail ? 0.06 : callout ? 0.03 : 0;
      uniforms.uBody.value = sheet ? 0.84 : detail ? 0.62 : callout ? 0.38 : major ? 0.24 : 0.12;
      uniforms.uEdge.value = sheet ? 0.14 : detail ? 0.28 : callout ? 0.40 : 0.46;
      uniforms.uLift.value = sheet ? 0.10 : detail ? 0.06 : callout ? 0.04 : major ? 0.025 : 0.015;
      uniforms.uPointer.value.copy(surface.pointer);
      uniforms.uPointerActive.value = surface.pointerActive ? 1 : 0;
      renderer.setSize(width, height, false);
      renderer.clear();
      renderer.render(scene, camera);
      surface.context.clearRect(0, 0, width, height);
      surface.context.drawImage(renderer.domElement, 0, 0, width, height);
      surface.element.dataset.glassReady = "true";
      diagnostics.ready++;
    }
    if (dirtySurfaces.size) scheduleRender(false);
  };

  const scheduleRender = (all = true) => {
    if (all) renderAll = true;
    if (!renderFrame) renderFrame = requestAnimationFrame(renderSurfaces);
  };

  const applyShadowVariables = () => {
    const css = document.documentElement.style;
    css.setProperty("--glass-inner-shadow", `inset 0 0 ${params.innerBlur}px ${params.innerSpread}px #ffffff`);
    css.setProperty("--glass-outer-shadow", `0 4px ${params.outerBlur}px rgba(0, 0, 0, ${params.outerOpacity})`);
  };
  applyShadowVariables();
  tuningHook = (patch) => {
    Object.assign(params, patch);
    applyShadowVariables();
    scheduleRender(true);
  };

  let rescanTimer = 0;
  const scan = () => {
    diagnostics.scans++;
    let added = false;
    let removed = false;
    const matches = root.querySelectorAll<HTMLElement>(GLASS_TARGETS);
    diagnostics.matched = matches.length;
    for (const element of matches) {
      if (surfaces.has(element)) continue;
      try {
        const surface = makeSurface(element);
        surfaces.set(element, surface);
        dirtySurfaces.add(surface);
        added = true;
      } catch (error) {
        console.warn("Vitrine could not attach a glass surface.", error);
      }
    }
    for (const [element, surface] of surfaces) {
      if (element.isConnected && root.contains(element) && element.matches(GLASS_TARGETS)) continue;
      releaseSurface(surface);
      surfaces.delete(element);
      removed = true;
    }
    // A panel can add its rows while they are still transparent/transformed by
    // the opening animation. Catch those that were skipped, and re-scan once
    // after the animation has settled.
    let unready = false;
    for (const [element, surface] of surfaces) {
      if (element.dataset.glassReady === "true" || !visible(element)) continue;
      dirtySurfaces.add(surface);
      unready = true;
    }
    diagnostics.added = added ? 1 : 0;
    if ((added || unready) && snapshotTexture) scheduleRender(false);
    if (added) {
      clearTimeout(rescanTimer);
      rescanTimer = window.setTimeout(() => scan(), 420);
    }
    if (removed) dirtySurfaces.clear();
  };

  scan();
  let scanTimer = 0;
  const observer = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 90);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });


  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const target = (event.target as Element | null)?.closest<HTMLElement>(GLASS_TARGETS) ?? null;
    if (!target) {
      if (pointerTarget) {
        pointerTarget.pointerActive = false;
        dirtySurfaces.add(pointerTarget);
        pointerTarget = null;
        scheduleRender(false);
      }
      return;
    }
    const surface = surfaces.get(target);
    if (!surface) return;
    const rect = target.getBoundingClientRect();
    surface.pointer.set(
      Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    );
    if (pointerTarget && pointerTarget !== surface) {
      pointerTarget.pointerActive = false;
      dirtySurfaces.add(pointerTarget);
    }
    pointerTarget = surface;
    surface.pointerActive = true;
    dirtySurfaces.add(surface);
    scheduleRender(false);
  };

  root.addEventListener("pointermove", onPointerMove, { passive: true });
  const onPointerLeave = () => {
    if (pointerTarget) {
      pointerTarget.pointerActive = false;
      dirtySurfaces.add(pointerTarget);
      pointerTarget = null;
      scheduleRender(false);
    }
  };
  root.addEventListener("pointerleave", onPointerLeave);

  // Only surfaces touched by the pointer need repainting. There is no
  // continuous 30 fps full-scene pass: when the cursor is still, the glass
  // canvases are static and cost no GPU work.

  const onBoardChange = () => scheduleRender(true);
  window.addEventListener("vitrine-wallpaper-changed", onBoardChange);

  const onResize = () => {
    uniforms.uViewport.value.set(Math.max(1, innerWidth), Math.max(1, innerHeight));
    scheduleRender(true);
  };
  window.addEventListener("resize", onResize, { passive: true });
  document.addEventListener("visibilitychange", onResize);
  const themeObserver = new MutationObserver(() => scheduleRender(true));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-dark-surface", "data-theme"] });

  // Large home surfaces refract the live 3D scene (the ring) rather than the
  // flat board. Only these few surfaces are refreshed, at 8 fps, so the glass
  // gains visible edge refraction without a full 60 fps redraw of every panel.
  // Rows can appear while the sheet is still animating and may miss the
  // initial dirty batch. Keep a low-frequency readiness pass so every visible
  // panel eventually gets its own shader layer.
  const readinessPulse = window.setInterval(() => {
    if (disposed || !snapshotTexture || document.hidden) return;
    diagnostics.surfaces = surfaces.size;
    let unreadyVisible = 0;
    for (const surface of surfaces.values()) {
      if (surface.element.dataset.glassReady === "true" || !visible(surface.element)) continue;
      dirtySurfaces.add(surface);
      unreadyVisible++;
    }
    diagnostics.unreadyVisible = unreadyVisible;
    diagnostics.dirty = dirtySurfaces.size;
    if (dirtySurfaces.size) scheduleRender(false);
  }, 300);

  const scenePulse = window.setInterval(() => {
    if (disposed || document.hidden || !document.hasFocus()) return;
    if (document.querySelector('#modal-root[data-open="true"]')) return;
    const first = !sceneTexture;
    const texture = getSceneTexture();
    if (!texture) return;
    texture.needsUpdate = true;
    if (first) {
      scheduleRender(true);
      return;
    }
    for (const surface of surfaces.values()) {
      if (!liveSceneSurface(surface.element) || !visible(surface.element)) continue;
      dirtySurfaces.add(surface);
    }
    if (dirtySurfaces.size) scheduleRender(false);
  }, 200);


  const modalRoot = document.querySelector<HTMLElement>("#modal-root");
  const modalObserver = modalRoot
    ? new MutationObserver(() => {
        if (modalRoot.dataset.open === "true") freezeSceneForModal();
      })
    : null;
  modalObserver?.observe(modalRoot!, { attributes: true, attributeFilter: ["data-open"] });

  return () => {
    disposed = true;
    window.clearInterval(scenePulse);
    window.clearInterval(readinessPulse);
    window.removeEventListener("vitrine-wallpaper-changed", onBoardChange);
    modalObserver?.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(rescanTimer);
    cancelAnimationFrame(renderFrame);
    observer.disconnect();
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onResize);
    themeObserver.disconnect();
    for (const surface of surfaces.values()) releaseSurface(surface);
    snapshotTexture?.dispose();
    sceneTexture?.dispose();
    frozenSceneTexture?.dispose();
    if (tuningHook === tuningHook) tuningHook = undefined;
    material.dispose();
    plane.geometry.dispose();
    renderer.dispose();
  };
}
