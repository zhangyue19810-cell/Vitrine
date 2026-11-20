import * as THREE from "three";

export type LightingLook = "baseline" | "refined";

/**
 * A compact photographic studio for the vitrine.
 *
 * The old RoomEnvironment was neutral and clean, but it gave every ivory,
 * glass and metal surface almost the same white reflection. This environment
 * keeps the studio softness while separating the materials: a warm key box,
 * a broad cool sky fill, a narrow teal rim and a low amber bounce. The archive
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
      color: new THREE.Color("#172428").multiplyScalar(0.42),
      side: THREE.BackSide,
    });
    const room = new THREE.Mesh(roomGeometry, roomMaterial);
    room.position.y = 7;
    this.add(room);
    this.owned.push(roomGeometry, roomMaterial);

    this.panel("#ffd6a6", 3.4, [10, 11], [-13, 15, 9], [-2, 4, 0]);
    this.panel("#a9d9ef", 2.0, [3, 16], [17, 11, 3], [0, 4, 0]);
    this.panel("#7de0d4", 1.8, [14, 2.4], [-2, 8, -20], [0, 4, 0]);
    this.panel("#ffbf8c", 1.0, [13, 7], [2, -9, 8], [0, 3, 0]);
    this.panel("#e9f7ff", 1.45, [7, 1.3], [2, 21, -2], [0, 4, 0]);

    // Long, narrow reflections make clearcoat and bevels legible.
    this.strip("#fff0d4", 3.8, [0.55, 17, 0.8], [-10, 9, 13]);
    this.strip("#8ce8e3", 2.4, [0.55, 12, 0.8], [10, 8, -7]);
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
  renderer.toneMappingExposure = refined ? 1.04 : 1.0;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = new ArchiveStudio();
  scene.environment = pmrem.fromScene(studio, 0.035).texture;
  studio.dispose();
  pmrem.dispose();
  scene.environmentIntensity = refined ? 0.98 : 0.92;

  scene.add(
    new THREE.HemisphereLight("#d7edf7", "#6b4d38", refined ? 0.55 : 0.5),
  );

  const key = new THREE.DirectionalLight("#ffe4c6", refined ? 2.35 : 2.15);
  key.position.set(...((refined ? [-9, 15, 8] : [-7, 15, 4]) as [number, number, number]));
  key.target.position.set(0, 1, 0);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight("#a9d9e8", refined ? 0.85 : 0.7);
  fill.position.set(9, 7, -7);
  fill.target.position.set(0, 1, 0);
  scene.add(fill.target);

  const rim = new THREE.DirectionalLight("#70e0d2", refined ? 1.6 : 1.2);
  rim.position.set(-4, 7, -13);
  rim.target.position.set(0, 2, 0);
  scene.add(rim.target);

  scene.add(key, fill, rim);
  return key;
}
