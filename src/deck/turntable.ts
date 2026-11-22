import * as THREE from "three";
import { RAIL_DARK, RAIL_LIGHT, paintDisc, type RailPalette } from "../rail/paint";
import type { Halo } from "../space/halo";
import { ARM, armAngle, armHead, armRest, pointToProgress, progressToRadius } from "./model";
import { Print } from "./print";

/**
 * The turntable of the now-playing page, standing in the main scene: a plinth with a printed dial, a platter, the record (its
 * label is the cover of the song) and a tonearm whose needle travels across the groove as the song goes on. The plates of the
 * Möbius ring stand round it (see `space/halo.ts`); this object only has to sit where the halo says. Everything inside is in
 * record radii (the record has radius 1; the plane of the plate is x/y, its normal +z), the group is scaled to the world.
 */

export interface TurntableState {
  /** A song is loaded (the needle goes to the groove). */
  song: boolean;
  playing: boolean;
  loading: boolean;
  /** 0 … 1, or null when the length is not known. */
  progress: number | null;
  cover: CanvasImageSource | null;
  /** Changes whenever `cover` does. */
  coverId: number;
  dark: boolean;
}

const VINYL = 1024;
const DIAL = 1024;
const PLINTH = 1.64;
const SPIN = 1.25;
const follow = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export class Turntable {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly record = new THREE.Group();
  private readonly recordDisc: THREE.Mesh;
  private readonly armYaw = new THREE.Group();
  private readonly armPitch = new THREE.Group();
  private readonly headHit: THREE.Mesh;
  private readonly materials: {
    plinth: THREE.MeshStandardMaterial;
    dial: THREE.MeshStandardMaterial;
    platter: THREE.MeshStandardMaterial;
    arm: THREE.MeshStandardMaterial;
    head: THREE.MeshStandardMaterial;
    weight: THREE.MeshStandardMaterial;
  };
  private readonly vinyl = new Print(VINYL, VINYL, 1, true, 8);
  private readonly dial = new Print(DIAL, DIAL, 1, true, 8);
  private palette: RailPalette = RAIL_LIGHT;
  private state: TurntableState = { song: false, playing: false, loading: false, progress: null, cover: null, coverId: -1, dark: false };
  private shown = { coverId: -2, dark: null as boolean | null, song: false };
  private spin = 0;
  private spinRate = 0;
  private arm = armAngle(armRest());
  private lift = 1;
  /** The needle is held by a finger at this fraction of the song. */
  private held: number | null = null;
  private appear = 0;
  private readonly basis = new THREE.Matrix4();
  private readonly right = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly point = new THREE.Vector3();
  private readonly ray = new THREE.Ray();

  constructor() {
    this.group.name = "turntable";
    this.group.add(this.body);
    const standard = (color: string, roughness = 0.75, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.materials = {
      plinth: standard("#f0ebde", 0.85),
      dial: new THREE.MeshStandardMaterial({ map: this.dial.texture, roughness: 0.82, metalness: 0 }),
      platter: standard("#101314", 0.55, 0.1),
      arm: standard("#f4f1e8", 0.4, 0.1),
      head: standard("#e8b967", 0.45),
      weight: standard("#1a1d1e", 0.5, 0.2),
    };
    const alongZ = (geometry: THREE.BufferGeometry) => {
      geometry.rotateX(Math.PI / 2);
      return geometry;
    };

    const plinth = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(PLINTH, PLINTH, 0.09, 112)), [this.materials.plinth, this.materials.dial, this.materials.plinth]);
    plinth.position.z = -0.045;
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    this.body.add(plinth);
    const platter = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(1.045, 1.045, 0.03, 96)), this.materials.platter);
    platter.position.z = 0.012;
    platter.receiveShadow = true;
    this.body.add(platter);

    // The record: black, with the cover on its label (printed in `paintVinyl`).
    const black = new THREE.MeshBasicMaterial({ color: 0x0a0c0d });
    this.recordDisc = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(1, 1, 0.022, 128)), [black, new THREE.MeshBasicMaterial({ map: this.vinyl.texture }), black]);
    this.record.position.z = 0.04;
    this.record.add(this.recordDisc);
    this.body.add(this.record);
    const spindle = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 24)), this.materials.arm);
    spindle.position.z = 0.075;
    this.body.add(spindle);

    // The tonearm.
    const pivot = new THREE.Group();
    pivot.position.set(ARM.pivot.x, ARM.pivot.y, 0.06);
    this.body.add(pivot);
    const base = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(0.13, 0.15, 0.1, 40)), this.materials.arm);
    base.position.z = -0.02;
    base.castShadow = true;
    pivot.add(base);
    const cap = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(0.065, 0.065, 0.05, 32)), this.materials.weight);
    cap.position.z = 0.05;
    pivot.add(cap);
    pivot.add(this.armYaw);
    this.armYaw.add(this.armPitch);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, ARM.length, 20), this.materials.arm);
    tube.rotation.z = Math.PI / 2;
    tube.position.x = ARM.length / 2;
    tube.castShadow = true;
    this.armPitch.add(tube);
    const weight = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.17, 28), this.materials.weight);
    weight.rotation.z = Math.PI / 2;
    weight.position.x = -0.2;
    this.armPitch.add(weight);
    const shell = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.075, 0.03), this.materials.head);
    shell.position.x = ARM.length + 0.05;
    shell.rotation.z = -0.1;
    shell.castShadow = true;
    this.armPitch.add(shell);
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.002, 0.045, 10), this.materials.weight);
    needle.rotation.x = Math.PI / 2;
    needle.position.set(ARM.length + 0.1, 0, -0.035);
    this.armPitch.add(needle);
    this.headHit = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.headHit.position.x = ARM.length + 0.04;
    this.armPitch.add(this.headHit);

    this.group.visible = false;
    this.applyTheme(false);
  }

  /** The turntable's frame in the world: where the halo says, `appear` (0 … 1) is how far it has risen into place. */
  place(halo: Halo, appear: number) {
    this.appear = appear;
    this.group.visible = appear > 0.003;
    if (!this.group.visible) return;
    const grown = appear * appear * (3 - 2 * appear);
    this.right.set(halo.right[0], halo.right[1], halo.right[2]);
    this.back.set(halo.back[0], halo.back[1], halo.back[2]);
    this.normal.set(halo.normal[0], halo.normal[1], halo.normal[2]);
    this.basis.makeBasis(this.right, this.back, this.normal);
    this.group.quaternion.setFromRotationMatrix(this.basis);
    // It rises out of the dark below the plane of the plate and grows to its size.
    this.group.position.set(halo.centre[0], halo.centre[1], halo.centre[2]).addScaledVector(this.normal, -(1 - grown) * halo.radius * 0.5);
    this.group.scale.setScalar(Math.max(0.0001, halo.radius * (0.55 + 0.45 * grown)));
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** What is playing. */
  setState(state: TurntableState) {
    this.state = state;
    if (state.dark !== this.shown.dark) this.applyTheme(state.dark);
    if (state.coverId !== this.shown.coverId || state.song !== this.shown.song) {
      this.shown.coverId = state.coverId;
      this.shown.song = state.song;
      this.vinyl.paint(`${state.coverId}|${state.dark}|${state.song}`, (ctx, w) => paintDisc(ctx, w, this.palette, state.cover, !state.song));
    }
  }

  /** The needle follows a finger (progress 0 … 1) or is let go (null). */
  hold(progress: number | null) {
    this.held = progress;
  }

  /** Advance by `dt` seconds; true while anything is still moving. */
  update(dt: number): boolean {
    if (!this.group.visible) return false;
    const state = this.state;
    let moving = false;
    const spinGoal = state.playing && !state.loading ? SPIN : 0;
    this.spinRate += (spinGoal - this.spinRate) * follow(2.6, dt);
    if (Math.abs(spinGoal - this.spinRate) < 0.003) this.spinRate = spinGoal;
    if (this.spinRate > 0) {
      this.spin += this.spinRate * dt;
      moving = true;
    }
    this.record.rotation.z = -this.spin;

    // The needle goes with the song, or follows the finger while the arm is held.
    const progress = this.held ?? state.progress;
    const head = state.song && progress !== null ? armHead(progressToRadius(progress)) : armRest();
    const angleGoal = armAngle(head);
    const armBefore = this.arm;
    this.arm += (angleGoal - this.arm) * follow(this.held !== null ? 40 : 6, dt);
    if (Math.abs(angleGoal - this.arm) < 0.0004) this.arm = angleGoal;
    const liftGoal = state.song && state.playing && !state.loading && this.held === null ? 0 : state.song && this.held !== null ? 0.35 : 1;
    const liftBefore = this.lift;
    this.lift += (liftGoal - this.lift) * follow(7, dt);
    if (Math.abs(liftGoal - this.lift) < 0.004) this.lift = liftGoal;
    if (this.arm !== armBefore || this.lift !== liftBefore) moving = true;
    this.armYaw.rotation.z = this.arm;
    this.armPitch.rotation.y = -this.lift * 0.16;
    return moving || this.appear < 0.999;
  }

  // ───────────────────────────────────────────── pointer ─────────────────────────────────────────────

  /** What a ray from the camera hits: the needle's head (drag it), the record (click it), or nothing. */
  hit(ray: THREE.Ray): "head" | "record" | null {
    if (!this.group.visible || this.appear < 0.6) return null;
    this.group.updateWorldMatrix(true, true);
    this.raycaster.ray.copy(ray);
    if (this.state.song && this.raycaster.intersectObject(this.headHit, false).length) return "head";
    if (this.raycaster.intersectObject(this.recordDisc, false).length) return "record";
    return null;
  }

  /** The song progress the needle would take if it followed the pointer whose ray this is. */
  progressAt(ray: THREE.Ray): number | null {
    this.group.updateWorldMatrix(true, false);
    this.inverse.copy(this.group.matrixWorld).invert();
    this.ray.copy(ray).applyMatrix4(this.inverse);
    if (!this.ray.intersectPlane(this.plane, this.point)) return null;
    return pointToProgress({ x: this.point.x, y: this.point.y });
  }

  /** Where the needle's head is in the world (for the time label that follows it). */
  headPosition(out: THREE.Vector3, progress: number): THREE.Vector3 {
    const head = armHead(progressToRadius(progress));
    out.set(head.x, head.y - 0.28, 0.08);
    this.group.updateWorldMatrix(true, false);
    return out.applyMatrix4(this.group.matrixWorld);
  }

  /** The middle of the record in the world. */
  centre(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false);
    return out.set(0, 0, 0.08).applyMatrix4(this.group.matrixWorld);
  }

  // ───────────────────────────────────────────── look ─────────────────────────────────────────────

  private applyTheme(dark: boolean) {
    if (this.shown.dark === dark) return;
    this.shown.dark = dark;
    this.palette = dark ? RAIL_DARK : RAIL_LIGHT;
    const p = this.palette;
    this.materials.plinth.color.set(dark ? "#1a2124" : p.paper);
    this.materials.platter.color.set(dark ? "#06090a" : "#101314");
    this.materials.arm.color.set(dark ? "#d9e1de" : "#f4f1e8");
    this.materials.head.color.set(p.accent);
    this.paintDial(dark);
    this.shown.coverId = -2;
  }

  /** The plate's printed dial: fine rings and a scale of ticks, like the face of an instrument. */
  private paintDial(dark: boolean) {
    const p = this.palette;
    this.dial.paint(`${dark}`, (ctx, w) => {
      const c = w / 2;
      const r = w / 2;
      ctx.fillStyle = dark ? "#1a2124" : p.paper;
      ctx.fillRect(0, 0, w, w);
      const ink = dark ? "rgba(201,212,209,0.55)" : "rgba(40,40,34,0.5)";
      const faint = dark ? "rgba(201,212,209,0.16)" : "rgba(40,40,34,0.14)";
      ctx.lineWidth = 1.2;
      // Orbit lines between the record and the plates.
      for (const fraction of [0.67, 0.71, 0.865, 0.905]) {
        ctx.strokeStyle = faint;
        ctx.beginPath();
        ctx.arc(c, c, r * fraction, 0, Math.PI * 2);
        ctx.stroke();
      }
      // The scale on the rim: a tick every 2.5°, longer every 10°, longest every 90°.
      for (let i = 0; i < 144; i++) {
        const a = (i / 144) * Math.PI * 2;
        const long = i % 36 === 0 ? 0.075 : i % 4 === 0 ? 0.05 : 0.026;
        ctx.strokeStyle = i % 36 === 0 ? p.accent : ink;
        ctx.lineWidth = i % 36 === 0 ? 3 : i % 4 === 0 ? 1.8 : 1;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r * (0.985 - long), c + Math.sin(a) * r * (0.985 - long));
        ctx.lineTo(c + Math.cos(a) * r * 0.985, c + Math.sin(a) * r * 0.985);
        ctx.stroke();
      }
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(c, c, r * 0.99, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  repaintAll() {
    this.shown.dark = null;
    this.shown.coverId = -2;
    this.applyTheme(this.state.dark);
    this.setState(this.state);
  }

  dispose() {
    this.vinyl.dispose();
    this.dial.dispose();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
  }
}
