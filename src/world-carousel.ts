import * as THREE from "three";
import { assetUrl } from "./asset-url";
import { WORLD_SCENES, WORLD_SWITCH_MS } from "./worlds";

/**
 * The home view's eight-photo Minecraft carousel.
 *
 * A transparent off-screen scene is laid into the main scene as its first,
 * depth-free layer. Only three curved picture frames are on screen at once:
 * the active one is complete in the middle, while the previous and next images
 * show exactly half a frame at the two edges. The photographs sit behind the
 * Möbius ring and never wrap the viewport: the warm-black 3D room remains
 * visible above, below and between the frames.
 */
export class WorldCarousel {
  /** The full-screen mesh that presents the off-screen carousel in the main scene. */
  readonly overlay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  private readonly world = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-80, 80, 50, -50, 0.1, 200);
  private readonly group = new THREE.Group();
  private readonly panelGeometry: THREE.PlaneGeometry;
  private readonly meshes: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly panelTints: THREE.Color[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly clearColor = new THREE.Color();
  private readonly forward = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private target?: THREE.WebGLRenderTarget;
  private targetWidth = 0;
  private targetHeight = 0;
  private aspect = 16 / 9;
  private aspectApplied = false;
  private targetDirty = true;
  private elapsed = 0;
  private step = 0;
  private scroll = 0;
  private targetScroll = 0;
  private lastScroll = Number.NaN;
  private reduced = false;
  private visible = true;

  private static readonly SWITCH_SECONDS = WORLD_SWITCH_MS / 1000;
  private static readonly IMAGE_ASPECT = 16 / 9;
  /** Half the screen width: a full frame in the middle and half frames at the edges. */
  private static readonly PANEL_SHARE = 0.52;

  private constructor(private readonly anisotropy: number) {
    this.world.name = "world-carousel-scene";
    this.group.name = "world-carousel-ring";
    this.world.add(this.group);
    this.camera.position.set(0, 0, 100);
    this.camera.lookAt(0, 0, 0);

    // Each photograph is a gently curved panel rather than a flat card. The
    // geometry is shared by all eight images; only the texture changes.
    this.panelGeometry = new THREE.PlaneGeometry(1, 1, 32, 1);
    const positions = this.panelGeometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      positions.setZ(i, x * x * 0.26);
    }
    positions.needsUpdate = true;
    this.panelGeometry.computeVertexNormals();

    this.overlay = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: {
          tScene: { value: null },
          uTheme: { value: 1 },
          uDeep: { value: 0 },
          uPaper: { value: new THREE.Color("#eae5e1") },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tScene;
          uniform float uTheme;
          uniform float uDeep;
          uniform vec3 uPaper;
          varying vec2 vUv;

          void main() {
            // The off-screen room is transparent outside its picture frames.
            // Discarding those pixels preserves the real 3D room around the
            // carousel instead of turning the photographs into full-screen
            // wallpaper.
            vec4 room = texture2D(tScene, vUv);
            if (room.a < 0.45) discard;
            vec3 image = room.rgb;
            vec2 radial = (vUv - 0.5) * vec2(1.0, 1.22);
            float vignette = 1.0 - 0.28 * smoothstep(0.28, 0.8, length(radial));
            vec3 dark = image * vec3(0.78, 0.72, 0.62) * vignette;
            vec2 glowPoint = vUv - vec2(0.22, 0.16);
            dark += vec3(0.031, 0.022, 0.009) * exp(-dot(glowPoint, glowPoint) * 9.0) * (1.0 - uDeep * 0.55);
            vec3 light = mix(uPaper, image, 0.24);
            vec3 color = mix(light, dark, uTheme);
            color *= 1.0 - uDeep * 0.45;
            gl_FragColor = vec4(color, 1.0);
          }
        `,
        transparent: false,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        side: THREE.FrontSide,
      }),
    );
    this.overlay.name = "world-carousel-overlay";
    this.overlay.renderOrder = -100000;
    this.overlay.frustumCulled = false;
    this.overlay.userData.excludeFromAO = true;
    this.overlay.castShadow = false;
    this.overlay.receiveShadow = false;
  }

  static async create(anisotropy = 8): Promise<WorldCarousel> {
    const carousel = new WorldCarousel(anisotropy);
    await carousel.load();
    return carousel;
  }

  private async load() {
    const loader = new THREE.TextureLoader();
    const textures = await Promise.all(
      WORLD_SCENES.map(async (scene) => {
        const texture = await loader.loadAsync(assetUrl(scene.src));
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = this.anisotropy;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        return texture;
      }),
    );
    this.textures.push(...textures);

    for (let i = 0; i < WORLD_SCENES.length; i++) {
      const material = this.panelMaterial(textures[i]);
      const tint = new THREE.Color();
      this.panelTints.push(tint);
      material.uniforms.uTint.value = tint;
      const mesh = new THREE.Mesh(this.panelGeometry, material);
      mesh.name = `world-panel-${WORLD_SCENES[i].id}`;
      mesh.frustumCulled = false;
      mesh.userData.excludeFromAO = true;
      mesh.userData.worldPanel = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(material);
    }
  }

  private panelMaterial(map: THREE.Texture) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uTint: { value: new THREE.Color() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vPanelUv;
        void main() {
          vPanelUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uTint;
        varying vec2 vPanelUv;

        void main() {
          vec3 image = texture2D(uMap, vPanelUv).rgb * uTint;
          float side = min(vPanelUv.x, 1.0 - vPanelUv.x);
          float top = min(vPanelUv.y, 1.0 - vPanelUv.y);
          // A dark bevel and a thin champagne edge make each photograph read
          // as a curved object in the room, not a flat background fill.
          float inset = smoothstep(0.014, 0.038, side) * smoothstep(0.01, 0.03, top);
          float rim = 1.0 - smoothstep(0.001, 0.016, min(side, top));
          float light = 0.84 + 0.16 * smoothstep(0.0, 0.8, 1.0 - abs(vPanelUv.x * 2.0 - 1.0));
          vec3 framed = mix(vec3(0.015, 0.011, 0.007), image * light, inset);
          framed += vec3(0.34, 0.24, 0.10) * rim * 0.55;
          gl_FragColor = vec4(framed, 1.0);
        }
      `,
      side: THREE.FrontSide,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });
  }

  /** Pause the ten-second cycle for the in-app "reduced motion" preference. */
  setReduced(reduced: boolean) {
    this.reduced = reduced;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.overlay.visible = visible;
  }

  get animating() {
    return Math.abs(this.scroll - this.targetScroll) > 0.0005;
  }

  get index() {
    return ((this.step % WORLD_SCENES.length) + WORLD_SCENES.length) % WORLD_SCENES.length;
  }

  update(dt: number, wallDt: number, mainCamera: THREE.PerspectiveCamera, aspect: number, theme: number, deep: number) {
    if (!this.visible) return;
    const safeDt = Math.min(0.25, Math.max(0.001, wallDt));
    if (!this.reduced) {
      this.elapsed += Math.min(30, Math.max(0.001, wallDt));
      if (this.elapsed >= WorldCarousel.SWITCH_SECONDS) {
        this.elapsed %= WorldCarousel.SWITCH_SECONDS;
        this.step += 1;
        this.targetScroll = this.step;
      }
    }
    this.scroll = THREE.MathUtils.damp(this.scroll, this.targetScroll, 1.7, safeDt);
    if (!Number.isFinite(this.lastScroll) || Math.abs(this.scroll - this.lastScroll) > 0.00001) {
      this.targetDirty = true;
      this.lastScroll = this.scroll;
    }

    this.setAspect(aspect);
    const halfWidth = 50 * aspect;
    const panelWidth = 100 * aspect * WorldCarousel.PANEL_SHARE;
    const panelHeight = panelWidth / WorldCarousel.IMAGE_ASPECT;
    const warm = 0.86 + theme * 0.02;
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      const distance = this.wrapSigned(i - this.scroll);
      const amount = Math.min(1, Math.abs(distance));
      const onScreen = Math.abs(distance) <= 1.02;
      mesh.visible = onScreen;
      if (!onScreen) continue;
      const scale = 1 - amount * 0.08;
      mesh.position.set(distance * halfWidth, 0, -amount * 11);
      mesh.rotation.set(0, -Math.sign(distance) * amount * 0.5, 0);
      mesh.scale.set(panelWidth * scale, panelHeight * scale, panelWidth);
      // Side frames graze the light; keep their photographs readable while the
      // centre frame stays the visual anchor.
      const lift = 0.98 + (1 - amount) * 0.08;
      this.panelTints[i].setRGB(warm * 0.96 * lift, warm * 0.9 * lift, warm * 0.8 * lift);
    }

    this.overlay.material.uniforms.uTheme.value = theme;
    this.overlay.material.uniforms.uDeep.value = deep;
    this.fitOverlay(mainCamera, aspect);
  }

  private wrapSigned(value: number) {
    const wrapped = ((value % WORLD_SCENES.length) + WORLD_SCENES.length) % WORLD_SCENES.length;
    return wrapped > WORLD_SCENES.length / 2 ? wrapped - WORLD_SCENES.length : wrapped;
  }

  private fitOverlay(camera: THREE.PerspectiveCamera, aspect: number) {
    const distance = Math.max(0.4, camera.near * 2);
    camera.getWorldDirection(this.forward);
    this.scratch.copy(camera.position).addScaledVector(this.forward, distance);
    this.overlay.position.copy(this.scratch);
    this.overlay.quaternion.copy(camera.quaternion);
    const height = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    this.overlay.scale.set(height * aspect, height, 1);
  }

  private setAspect(aspect: number) {
    if (this.aspectApplied && Math.abs(aspect - this.aspect) < 0.0001) return;
    this.aspect = aspect;
    this.aspectApplied = true;
    this.camera.left = -50 * aspect;
    this.camera.right = 50 * aspect;
    this.camera.top = 50;
    this.camera.bottom = -50;
    this.camera.updateProjectionMatrix();
    this.targetDirty = true;
  }

  private ensureTarget() {
    let width = 1280;
    let height = Math.round(width / this.aspect);
    if (height > 800) {
      height = 800;
      width = Math.round(height * this.aspect);
    }
    width = Math.max(320, width);
    height = Math.max(180, height);
    if (this.target && width === this.targetWidth && height === this.targetHeight) return;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.name = "WorldCarousel";
    this.target.texture.generateMipmaps = false;
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.targetWidth = width;
    this.targetHeight = height;
    this.targetDirty = true;
    this.overlay.material.uniforms.tScene.value = this.target.texture;
  }

  /** Draw the carousel room into its private transparent render target. */
  render(renderer: THREE.WebGLRenderer) {
    if (!this.visible) return;
    this.ensureTarget();
    if (!this.target || !this.targetDirty) return;
    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(this.clearColor).clone();
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear();
    renderer.render(this.world, this.camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClear, previousAlpha);
    renderer.autoClear = previousAutoClear;
    this.targetDirty = false;
  }

  dispose() {
    this.overlay.removeFromParent();
    this.overlay.geometry.dispose();
    this.overlay.material.dispose();
    this.target?.dispose();
    this.panelGeometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.meshes.length = 0;
    this.materials.length = 0;
    this.panelTints.length = 0;
    this.textures.length = 0;
    this.group.clear();
    this.target = undefined;
    this.overlay.material.uniforms.tScene.value = null;
  }
}
