import * as THREE from "three";

export type LightingLook = "baseline" | "refined";

/**
 * A compact photographic studio for the vitrine.
 *
 * The old RoomEnvironment was neutral and clean, but it gave every ivory,
 * glass and metal surface almost the same white reflection. This environment
 * keeps the studio softness while separating the materials: a warm key box,
 * a broad amber fill, a narrow gold rim and a low amber bounce. The archive
 * can then show a readable transition from lit edge to shadow instead of
 * dissolving into the background.
 */
class ArchiveStudio extends THREE.Scene {
  private readonly owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor() {
    super();
    this.name = "ArchiveStudio";

    const roomGeometry = new THREE.BoxGeometry(48, 32, 48);
    const roomMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#17120e").multiplyScalar(0.42),
      side: THREE.BackSide,
    });
    const room = new THREE.Mesh(roomGeometry, roomMaterial);
    room.position.y = 7;
    this.add(room);
    this.owned.push(roomGeometry, roomMaterial);

    this.panel("#ffd39a", 4.8, [11, 12], [-13, 15, 9], [-2, 4, 0]);
    this.panel("#e3bd83", 2.25, [3, 16], [17, 11, 3], [0, 4, 0]);
    this.panel("#ffc96b", 2.45, [14, 2.4], [-2, 8, -20], [0, 4, 0]);
    this.panel("#ffae63", 1.2, [13, 7], [2, -9, 8], [0, 3, 0]);
    this.panel("#fff1d8", 1.8, [7, 1.3], [2, 21, -2], [0, 4, 0]);
    // A lower, broader bounce keeps the dark sides of the metal from going
    // completely black, so the reflection has a readable falloff.
    this.panel("#d7b47c", 0.9, [15, 5], [0, -5, 18], [0, 3, 0]);

    // Long, narrow gold reflections make clearcoat, bevels and inlays legible.
    this.strip("#fff1d2", 5.8, [0.55, 19, 0.8], [-10, 9, 13]);
    this.strip("#ffc56b", 3.7, [0.55, 14, 0.8], [10, 8, -7]);
    this.strip("#fff6e6", 3.1, [12, 0.5, 0.65], [-1, 18, 6]);
  }

  private panel(color: string, power: number, size: [number, number], position: [number, number, number], target: [number, number, number]) {
    const geometry = new THREE.PlaneGeometry(size[0], size[1]);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(power),
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.lookAt(...target);
    this.add(mesh);
    this.owned.push(geometry, material);
  }

  private strip(color: string, power: number, size: [number, number, number], position: [number, number, number]) {
    const geometry = new THREE.BoxGeometry(...size);
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    this.add(mesh);
    this.owned.push(geometry, material);
  }

  dispose() {
    for (const resource of this.owned) resource.dispose();
    this.owned.length = 0;
  }
}

// The archive and its independent viewer use the same studio illumination.
// Each WebGL renderer needs its own PMREM render target / texture.
export function createArchiveLighting(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  look: LightingLook = "baseline",
) {
  const refined = look === "refined";
  renderer.toneMappingExposure = refined ? 1.2 : 1.08;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = new ArchiveStudio();
  scene.environment = pmrem.fromScene(studio, 0.035).texture;
  studio.dispose();
  pmrem.dispose();
  scene.environmentIntensity = refined ? 1.34 : 1.06;

  scene.add(
    new THREE.HemisphereLight("#f6e7cd", "#4b351b", refined ? 0.64 : 0.55),
  );

  const key = new THREE.DirectionalLight("#ffd5a0", refined ? 3.35 : 2.7);
  key.position.set(...((refined ? [-9, 15, 8] : [-7, 15, 4]) as [number, number, number]));
  key.target.position.set(0, 1, 0);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight("#e6c08b", refined ? 1.34 : 0.9);
  fill.position.set(9, 7, -7);
  fill.target.position.set(0, 1, 0);
  scene.add(fill.target);

  const rim = new THREE.DirectionalLight("#ffc15c", refined ? 2.65 : 1.6);
  rim.position.set(-4, 7, -13);
  rim.target.position.set(0, 2, 0);
  scene.add(rim.target);

  scene.add(key, fill, rim);
  return key;
}
