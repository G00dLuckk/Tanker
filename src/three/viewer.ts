import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Derived } from '../core/derive';
import { manholeHalf, planToTank, type ManholeGeom, type Reading, type SensorGeom } from '../core/sensors';
import { contains } from '../core/shape';
import type { ViewState } from '../core/types';
import { fmtLen, type LengthUnit } from '../core/units';
import { buildPitGeometry, buildPitSurface } from './pitGeometry';
import { buildSurface, buildTankGeometry, tankToLocal, type TankGeometry } from './tankGeometry';

/** Render geometry of a tank or a concrete storage. */
function geometryOf(d: Derived, segments?: number): TankGeometry {
  return d.kind === 'pit' ? buildPitGeometry(d.pit) : buildTankGeometry(d.model, segments);
}

export interface SensorVisual {
  geom: SensorGeom;
  color: string;
}

/** A tank of the site as the 3D view shows it. */
export interface SiteTank {
  /** Changes when the tank's shape changes (its geometry is rebuilt). */
  key: string;
  d: Derived;
  name: string;
  /** Simulated level (mm). */
  level: number;
}

/** Another tank of the site, drawn beside the one being edited. */
interface Neighbour {
  key: string;
  index: number;
  group: THREE.Group;
  /** Offset of the tank's middle from its local origin along X, and its lift (m). */
  centreX: number;
  lift: number;
  plane: THREE.Plane;
  d: Derived;
  label: CSS2DObject;
  mats: THREE.Material[];
}

export interface ViewerTheme {
  dark: boolean;
  grid: string;
  gridMajor: string;
}

const MM = 0.001;

interface SensorObj {
  id: string;
  geom: SensorGeom;
  group: THREE.Group;
  beam?: THREE.Mesh;
  beamLine?: THREE.Line;
  hit?: THREE.Mesh;
  head?: THREE.Line;
  float?: THREE.Mesh;
  mats: THREE.MeshStandardMaterial[];
  label: CSS2DObject;
  /** Sits in the front half that the cut-away view removes. */
  front: boolean;
}

export class TankViewer {
  readonly renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private tank = new THREE.Group();
  private world = new THREE.Group();
  private sensorGroup = new THREE.Group();
  private manholeGroup = new THREE.Group();
  private dimGroup = new THREE.Group();
  private grid: THREE.GridHelper | null = null;
  private ground: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private waterPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private mats: Record<string, THREE.Material> = {};
  private edgeMat = new THREE.LineBasicMaterial({ color: 0x2b3a44 });
  private meshes: Record<string, THREE.Mesh> = {};
  private surface: THREE.Mesh | null = null;
  private geo: TankGeometry | null = null;
  private d: Derived | null = null;
  private sensors: SensorObj[] = [];
  private view: ViewState = { mode: 'cutaway', dims: true, beams: true, labels: true, grid: true };
  private level = 0;
  private unit: LengthUnit = 'mm';
  private dirty = true;
  private selected: string | null = null;
  private fitRadius = 1;
  private disposed = false;
  private resizeObs: ResizeObserver;
  /** Other tanks of the site, by position in the site. */
  private neighbours: Neighbour[] = [];
  private siteGroup = new THREE.Group();
  /** Middle of each tank along X (mm) and the tank being edited. */
  private slots: number[] = [0];
  private activeIndex = 0;
  private siteNames: string[] = [];
  private nameTag: CSS2DObject | null = null;
  onSelectSensor: ((id: string | null) => void) | null = null;
  onSelectTank: ((index: number) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'viewport-canvas';
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'viewport-labels';
    // Let labels near the edge spill over instead of being cut off.
    this.labels.domElement.style.overflow = 'visible';
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
    this.camera.position.set(4, 3, 6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.98;
    this.controls.addEventListener('change', () => (this.dirty = true));

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;

    this.scene.add(new THREE.HemisphereLight(0xdfe9f0, 0x3a434a, 0.9));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.16 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.tank.scale.setScalar(MM);
    this.tank.add(this.sensorGroup, this.manholeGroup, this.dimGroup);
    this.scene.add(this.world, this.tank, this.siteGroup);
    this.createMaterials();

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.loop();
  }

  // -------------------------------------------------------------------------
  // Materials

  private createMaterials() {
    const clipCut = [this.cutPlane];
    this.mats.outer = new THREE.MeshStandardMaterial({
      color: 0xb9c5cd,
      metalness: 0.55,
      roughness: 0.36,
      clippingPlanes: clipCut,
    });
    this.mats.innerWall = new THREE.MeshStandardMaterial({
      color: 0x93a1ab,
      metalness: 0.25,
      roughness: 0.62,
      side: THREE.BackSide,
      clippingPlanes: clipCut,
    });
    this.mats.wallCut = new THREE.MeshBasicMaterial({ map: hatchTexture(), side: THREE.DoubleSide });
    this.mats.waterBack = new THREE.MeshPhysicalMaterial({
      color: 0x1f7fd0,
      transparent: true,
      opacity: 0.5,
      roughness: 0.15,
      metalness: 0,
      side: THREE.BackSide,
      clippingPlanes: [this.waterPlane, this.cutPlane],
      depthWrite: false,
    });
    this.mats.waterFront = new THREE.MeshPhysicalMaterial({
      color: 0x2a8fe0,
      transparent: true,
      opacity: 0.42,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 0.6,
      side: THREE.FrontSide,
      clippingPlanes: [this.waterPlane, this.cutPlane],
      depthWrite: false,
    });
    this.mats.waterCut = new THREE.MeshStandardMaterial({
      color: 0x1e78c8,
      transparent: true,
      opacity: 0.82,
      roughness: 0.35,
      side: THREE.DoubleSide,
      clippingPlanes: [this.waterPlane],
      depthWrite: false,
    });
    this.mats.surface = new THREE.MeshPhysicalMaterial({
      color: 0x73c2ff,
      transparent: true,
      opacity: 0.72,
      roughness: 0.04,
      metalness: 0,
      clearcoat: 1,
      side: THREE.DoubleSide,
      clippingPlanes: clipCut,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mats.support = new THREE.MeshStandardMaterial({ color: 0x7d8a93, metalness: 0.4, roughness: 0.55 });
    this.mats.manhole = new THREE.MeshStandardMaterial({
      color: 0xa9b6bf,
      metalness: 0.55,
      roughness: 0.4,
      side: THREE.DoubleSide,
      clippingPlanes: clipCut,
    });
  }

  // -------------------------------------------------------------------------
  // Public API

  setUnit(u: LengthUnit) {
    this.unit = u;
    this.updateLevelVisuals();
    this.dirty = true;
  }

  setTheme(t: ViewerTheme) {
    this.edgeMat.color.set(t.dark ? 0x9fb3bf : 0x2b3a44);
    (this.ground.material as THREE.ShadowMaterial).opacity = t.dark ? 0.32 : 0.16;
    this.gridColors = [t.gridMajor, t.grid];
    this.rebuildGrid();
    this.dirty = true;
  }

  private gridColors: [string, string] = ['#9fb3bf', '#d4dde2'];

  setView(v: ViewState) {
    const modeChanged = v.mode !== this.view.mode;
    this.view = { ...v };
    this.applyView();
    if (modeChanged) this.updateLevelVisuals();
    this.dirty = true;
  }

  /** Rebuilds all tank geometry. */
  setTank(d: Derived, sensors: SensorVisual[], level: number, refit: boolean) {
    this.d = d;
    this.level = level;
    for (const k of Object.keys(this.meshes)) {
      const m = this.meshes[k];
      m.geometry.dispose();
      m.removeFromParent();
    }
    this.meshes = {};
    removeLabels(this.world);
    this.world.clear();
    this.nameTag = null;

    const m = d.model;
    const geo = geometryOf(d);
    this.geo = geo;

    // Orientation and tilt: rotate about world Z, then sit the tank on its supports.
    this.tank.rotation.set(0, 0, m.orientation === 'vertical' ? (-d.tilt * Math.PI) / 180 : (d.tilt * Math.PI) / 180);
    this.tank.position.set(0, 0, 0);
    this.tank.updateMatrixWorld(true);

    const add = (key: string, g: THREE.BufferGeometry, mat: THREE.Material, order = 0, shadow = false) => {
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = order;
      mesh.castShadow = shadow;
      mesh.receiveShadow = shadow;
      this.meshes[key] = mesh;
      this.tank.add(mesh);
      return mesh;
    };
    add('outer', geo.outer, this.mats.outer, 0, true);
    add('innerWall', geo.inner, this.mats.innerWall, 0);
    add('wallCut', geo.wallCut, this.mats.wallCut, 0);
    add('waterBack', geo.water, this.mats.waterBack, 2);
    add('waterCut', geo.cavityCut, this.mats.waterCut, 3);
    add('waterFront', geo.water.clone(), this.mats.waterFront, 4);
    const edges = new THREE.LineSegments(geo.sectionEdges, this.edgeMat);
    edges.renderOrder = 1;
    this.meshes.sectionEdges = edges as unknown as THREE.Mesh;
    this.tank.add(edges);

    // Rest the lowest outer point on the supports, in this tank's place on the site.
    const box = new THREE.Box3().setFromObject(this.meshes.outer);
    const clearance = this.clearance(d) * MM;
    this.tank.position.y = clearance - box.min.y;
    this.tank.position.x = (this.slots[this.activeIndex] ?? 0) * MM - (box.min.x + box.max.x) / 2;
    this.tank.updateMatrixWorld(true);
    this.buildSupports(d, clearance, this.tank, this.world, this.mats.support);
    if (this.siteNames.length > 1) {
      const outer = new THREE.Box3().setFromObject(this.meshes.outer);
      this.nameTag = this.siteTag(this.siteNames[this.activeIndex] ?? '', true, this.activeIndex);
      this.nameTag.position.set((outer.min.x + outer.max.x) / 2, outer.max.y + 0.05 * (outer.max.y - outer.min.y) + 0.15, 0);
      this.world.add(this.nameTag);
    }

    const wbox = new THREE.Box3().setFromObject(this.meshes.outer);
    wbox.min.y = 0;
    const sphere = wbox.getBoundingSphere(new THREE.Sphere());
    this.fitRadius = sphere.radius;
    this.controls.target.copy(sphere.center);
    this.rebuildGrid();
    this.updateLights(sphere);
    this.buildDims();
    this.setSensors(sensors);
    this.applyView();
    this.updateLevelVisuals();
    if (refit) this.fit('iso', false);
    this.dirty = true;
  }

  /** Swaps in a new derivation of the same tank geometry (sensors or liquid changed). */
  updateDerived(d: Derived) {
    this.d = d;
  }

  setSensors(list: SensorVisual[]) {
    for (const s of this.sensors) {
      s.group.removeFromParent();
      removeLabels(s.group);
      disposeTree(s.group);
    }
    this.sensors = [];
    for (const c of [...this.manholeGroup.children]) {
      c.removeFromParent();
      // The material is shared, so only the geometry is freed.
      c.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    if (!this.d) return;
    const m = this.d.model;
    for (const mg of this.d.manholes) if (mg.ok) this.manholeGroup.add(this.buildManhole(mg));
    const r = Math.min(Math.max(m.size * 0.022, 22), 120);
    for (const sv of list) {
      const g = sv.geom;
      if (!g.ok || !g.sensor.enabled) continue;
      this.sensors.push(this.buildSensor(sv, r));
    }
    this.highlight();
    this.applyView();
    this.dirty = true;
  }

  setSelected(id: string | null) {
    this.selected = id;
    this.highlight();
    this.dirty = true;
  }

  setLevel(level: number) {
    this.level = level;
    this.updateLevelVisuals();
    this.dirty = true;
  }

  /** Updates per-sensor live visuals (beam length, switch state). */
  setReadings(readings: Map<string, Reading>) {
    if (!this.d) return;
    for (const s of this.sensors) {
      const r = readings.get(s.id);
      if (s.beam && s.beamLine && s.hit) {
        const g = s.geom;
        const dist = r && Number.isFinite(r.trueValue) ? Math.min(r.trueValue, g.floorDist) : g.floorDist;
        const half = (Math.min(Math.max(g.sensor.beamAngle, 0.5), 170) / 2) * (Math.PI / 180);
        const rad = Math.max(dist * Math.tan(half), 1);
        s.beam.scale.set(rad, Math.max(dist, 1), rad);
        const pos = s.beamLine.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(1, 0, -dist, 0);
        pos.needsUpdate = true;
        s.beamLine.computeLineDistances();
        s.hit.position.set(0, -dist, 0);
        const ok = r?.status === 'ok';
        (s.beam.material as THREE.MeshBasicMaterial).opacity = ok ? 0.16 : 0.07;
        s.hit.visible = ok || r?.status === 'deadband';
        s.label.element.classList.toggle('is-warn', !!r && !ok);
      }
      if (s.head && this.d) {
        const g = s.geom;
        const headMm = Math.max(0, this.level - g.faceLevel);
        const pos = s.head.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(1, 0, headMm / Math.max(g.cosTilt, 1e-6), 0);
        pos.needsUpdate = true;
        s.head.computeLineDistances();
        s.head.visible = headMm > 0 && this.view.beams;
      }
      if (s.float) {
        const on = r?.digital === 1;
        const mat = s.float.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = on ? 0.9 : 0;
        s.label.element.classList.toggle('is-on', on);
      }
    }
    this.dirty = true;
  }

  /**
   * The tanks of the site, left to right, and the one being edited. Call before
   * setTank: it sets where the edited tank stands. Other tanks are rebuilt only
   * when their key changes.
   */
  setSite(list: SiteTank[], active: number) {
    this.activeIndex = Math.min(Math.max(active, 0), Math.max(list.length - 1, 0));
    this.siteNames = list.map((t) => t.name);
    // Footprint along X of each tank and the gap between them.
    const widths = list.map((t) => (t.d.model.orientation === 'vertical' ? Math.max(t.d.model.outer.width, 1) : Math.max(t.d.model.outer.length, 1)));
    const gap = Math.max(800, 0.35 * Math.max(...list.map((t) => t.d.model.size), 1));
    this.slots = [];
    let x = 0;
    widths.forEach((w) => {
      this.slots.push(x + w / 2);
      x += w + gap;
    });
    // Keep the edited tank at its place and the row around it.
    const shift = this.slots[this.activeIndex] ?? 0;
    this.slots = this.slots.map((s) => s - shift);

    const keep = new Map(this.neighbours.map((n) => [n.key + '#' + n.index, n]));
    const next: Neighbour[] = [];
    list.forEach((t, i) => {
      if (i === this.activeIndex) return;
      const k = t.key + '#' + i;
      let n = keep.get(k);
      if (n) keep.delete(k);
      else n = this.buildNeighbour(t, i);
      n.d = t.d;
      n.label.element.querySelector('.site-tag-name')!.textContent = t.name;
      this.placeNeighbour(n, t.level);
      next.push(n);
    });
    for (const n of keep.values()) this.dropNeighbour(n);
    this.neighbours = next;
    this.dirty = true;
  }

  /** Bounding sphere of every tank on the site (m). */
  private siteSphere(): THREE.Sphere {
    const box = new THREE.Box3();
    if (this.meshes.outer) box.expandByObject(this.meshes.outer);
    for (const n of this.neighbours) box.expandByObject(n.group);
    box.min.y = 0;
    return box.getBoundingSphere(new THREE.Sphere());
  }

  private siteTag(name: string, active: boolean, index: number): CSS2DObject {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `site-tag${active ? ' is-active' : ''}`;
    const nm = document.createElement('span');
    nm.className = 'site-tag-name';
    nm.textContent = name;
    el.append(nm);
    el.title = active ? `${name}: the tank you are editing` : `Edit ${name}`;
    el.addEventListener('click', () => {
      if (!active) this.onSelectTank?.(index);
    });
    const o = new CSS2DObject(el);
    o.center.set(0.5, 1);
    return o;
  }

  private buildNeighbour(t: SiteTank, index: number): Neighbour {
    const m = t.d.model;
    const geo = geometryOf(t.d, 64);
    const group = new THREE.Group();
    group.scale.setScalar(MM);
    group.rotation.set(0, 0, m.orientation === 'vertical' ? (-t.d.tilt * Math.PI) / 180 : (t.d.tilt * Math.PI) / 180);
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const shell = new THREE.MeshStandardMaterial({ color: 0xb9c5cd, metalness: 0.5, roughness: 0.4, transparent: true, opacity: 0.38, depthWrite: false });
    const water = new THREE.MeshStandardMaterial({ color: 0x2a8fe0, roughness: 0.2, transparent: true, opacity: 0.7, side: THREE.DoubleSide, clippingPlanes: [plane], depthWrite: false });
    const outer = new THREE.Mesh(geo.outer, shell);
    outer.renderOrder = 6;
    outer.castShadow = true;
    outer.userData.tankIndex = index;
    const liquid = new THREE.Mesh(geo.water, water);
    liquid.renderOrder = 4;
    liquid.userData.tankIndex = index;
    group.add(liquid, outer);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(outer);
    const lift = this.clearance(t.d) * MM - box.min.y;
    const centreX = (box.min.x + box.max.x) / 2;
    const label = this.siteTag(t.name, false, index);
    label.position.set(centreX, box.max.y + lift + 0.05 * (box.max.y - box.min.y) + 0.15, 0);
    const holder = new THREE.Group();
    holder.add(group);
    this.siteGroup.add(holder);
    const legs = new THREE.Group();
    holder.add(legs);
    holder.add(label);
    const n: Neighbour = { key: t.key, index, group, centreX, lift, plane, d: t.d, label, mats: [shell, water] };
    group.position.y = lift;
    group.updateMatrixWorld(true);
    this.buildSupports(t.d, this.clearance(t.d) * MM, group, legs, this.mats.support);
    return n;
  }

  private placeNeighbour(n: Neighbour, level: number) {
    const holder = n.group.parent!;
    holder.position.x = (this.slots[n.index] ?? 0) * MM - n.centreX;
    holder.updateMatrixWorld(true);
    const e = n.d.engine;
    const lv = Math.min(Math.max(Number.isFinite(level) ? level : 0.62 * e.depth, 0), e.depth);
    const h = e.hMin + lv;
    const dir = e.axis === -1 ? [1, 0, 0] : e.axis === 0 ? [e.na, e.nw, 0] : [e.na, 0, e.nw];
    const p = tankToLocal(n.d.model, dir[0] * h, dir[1] * h, dir[2] * h);
    const pw = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(n.group.matrixWorld);
    n.plane.constant = lv >= e.depth - 1e-9 ? pw.y + 1 : pw.y;
    n.group.children[0].visible = lv > 0;
  }

  private dropNeighbour(n: Neighbour) {
    const holder = n.group.parent!;
    holder.removeFromParent();
    removeLabels(holder);
    holder.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    n.mats.forEach((m) => m.dispose());
  }

  fit(view: 'iso' | 'front' | 'side' | 'top' | 'site', animate = true) {
    if (view === 'site') {
      const s = this.siteSphere();
      this.controls.target.copy(s.center);
      const keep = this.fitRadius;
      this.fitRadius = s.radius;
      this.fit('iso', animate);
      this.fitRadius = keep;
      return;
    }
    const dir =
      view === 'front'
        ? new THREE.Vector3(0, 0.12, 1)
        : view === 'side'
          ? new THREE.Vector3(1, 0.12, 0)
          : view === 'top'
            ? new THREE.Vector3(0, 1, 0.0001)
            : new THREE.Vector3(0.95, 0.72, 1.55);
    dir.normalize();
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = (this.fitRadius / Math.sin(Math.min(vHalf, hHalf))) * 1.12;
    const target = this.controls.target.clone();
    const to = target.clone().add(dir.multiplyScalar(dist));
    this.camera.near = Math.max(dist / 500, 0.005);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = dist * 6;
    this.controls.minDistance = dist * 0.08;
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(to);
      this.controls.update();
      this.dirty = true;
      return;
    }
    const from = this.camera.position.clone();
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 450);
      const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.camera.position.lerpVectors(from, to, k);
      this.controls.update();
      this.dirty = true;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  screenshot(): string {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    this.resizeObs.disconnect();
    this.renderer.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals

  private clearance(d: Derived): number {
    const m = d.model;
    if (d.kind === 'pit') return 0;
    if (m.orientation === 'horizontal') return Math.max(120, 0.14 * m.outer.depth);
    if (m.bodyType === 'sphere') return Math.max(150, 0.12 * m.outer.width);
    if (m.start.type === 'flat') return 0;
    return Math.max(150, 0.17 * Math.max(m.outer.width, m.outer.depth));
  }

  private toWorld(p: [number, number, number]): THREE.Vector3 {
    return new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.tank.matrixWorld);
  }

  private buildSupports(d: Derived, clearance: number, tank: THREE.Object3D, into: THREE.Object3D, mat: THREE.Material) {
    const m = d.model;
    const toWorld = (p: [number, number, number]) => into.worldToLocal(new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(tank.matrixWorld));
    if (clearance <= 0) return;
    const legR = Math.max(m.size * 0.012, 12) * MM;
    if (m.orientation === 'vertical') {
      // Four legs from the ground to the lower end of the shell.
      const aAttach = m.bodyType === 'sphere' ? 0 : Math.min(m.L * 0.15, 150);
      const corners: [number, number][] =
        m.base.kind === 'polygon' && m.base.poly?.general
          ? [45, 135, 225, 315].map((deg) => {
              // Pull each leg in until it sits under the shell of this outline.
              const t = (deg * Math.PI) / 180;
              let k = 1;
              while (k > 0.2 && !contains(m.base, Math.cos(t) * m.base.A * k, Math.sin(t) * m.base.B * k)) k -= 0.02;
              return [Math.cos(t) * m.base.A * k * 0.97, Math.sin(t) * m.base.B * k * 0.97];
            })
          : m.base.kind !== 'roundrect'
          ? [45, 135, 225, 315].map((deg) => {
              const t = (deg * Math.PI) / 180;
              return [Math.cos(t) * (m.base.A + m.t.shell), Math.sin(t) * (m.base.B + m.t.shell)];
            })
          : [
              [1, 1],
              [-1, 1],
              [-1, -1],
              [1, -1],
            ].map(([sx, sy]) => [sx * (m.base.A + m.t.shell) * 0.94, sy * (m.base.B + m.t.shell) * 0.94]);
      for (const [u, v] of corners) {
        const top = toWorld(tankToLocal(m, aAttach, u, v));
        const h = top.y;
        if (h <= 0) continue;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(legR, legR * 1.1, h, 12), mat);
        leg.position.set(top.x, h / 2, top.z);
        leg.castShadow = true;
        into.add(leg);
        const foot = new THREE.Mesh(new THREE.BoxGeometry(legR * 5, legR * 0.8, legR * 5), mat);
        foot.position.set(top.x, legR * 0.4, top.z);
        into.add(foot);
      }
      return;
    }
    // Two saddles under a horizontal tank.
    const L = Math.max(m.L, 1);
    for (const f of [0.2, 0.8]) {
      const a = m.L > 0 ? f * L : 0;
      const s = m.section(a, { ku: 0, kv: 0, cu: 0, cv: 0 });
      const bottom = toWorld(tankToLocal(m, a, s.cu, s.cv - s.kv * m.base.B - m.t.shell));
      const h = bottom.y;
      if (h <= 0) continue;
      const w = (m.base.A + m.t.shell) * 2 * 0.62 * MM;
      const depth = Math.max(m.size * 0.035, 60) * MM;
      // The saddle rises a little into the shell so its top is hidden by the curve.
      const top = h + 0.18 * m.base.B * MM;
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(depth, top, w), mat);
      saddle.position.set(bottom.x, top / 2, bottom.z);
      saddle.castShadow = true;
      saddle.receiveShadow = true;
      into.add(saddle);
      const base = new THREE.Mesh(new THREE.BoxGeometry(depth * 1.6, legR * 0.8, w * 1.08), mat);
      base.position.set(bottom.x, legR * 0.4, bottom.z);
      into.add(base);
    }
  }

  private rebuildGrid() {
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid.removeFromParent();
      this.grid = null;
    }
    const r = Math.max(this.fitRadius, 0.2);
    const size = niceGrid(r * 6);
    const cell = size.cell;
    const divisions = Math.round(size.size / cell);
    this.grid = new THREE.GridHelper(size.size, divisions, this.gridColors[0], this.gridColors[1]);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.75;
    this.grid.position.set(this.controls.target.x, 0.0005, this.controls.target.z);
    this.grid.visible = this.view.grid;
    this.scene.add(this.grid);
    this.ground.scale.setScalar(size.size);
    this.ground.position.set(this.controls.target.x, 0, this.controls.target.z);
  }

  private updateLights(sphere: THREE.Sphere) {
    const r = sphere.radius;
    this.sun.position.set(sphere.center.x + r * 1.4, r * 3.2, sphere.center.z + r * 1.9);
    this.sun.target.position.copy(sphere.center);
    const cam = this.sun.shadow.camera;
    cam.left = -r * 1.6;
    cam.right = r * 1.6;
    cam.top = r * 1.6;
    cam.bottom = -r * 1.6;
    cam.near = r * 0.1;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
  }

  private buildSensor(sv: SensorVisual, r: number): SensorObj {
    const g = sv.geom;
    const s = g.sensor;
    const m = this.d!.model;
    const group = new THREE.Group();
    const color = new THREE.Color(sv.color);
    const mats: THREE.MeshStandardMaterial[] = [];
    const mat = (c: THREE.Color | number, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const mm = new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.2, emissive: color, emissiveIntensity: 0, ...extra });
      mats.push(mm);
      return mm;
    };
    const face = tankToLocal(m, g.face[0], g.face[1], g.face[2]);
    group.position.set(face[0], face[1], face[2]);
    const obj: SensorObj = { id: s.id, geom: g, group, mats, label: this.makeTag(s.tag, sv.color), front: face[2] > 1 };

    if (g.mount === 'top') {
      const h = r * 1.5;
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 28), mat(color));
      housing.position.y = h / 2;
      housing.castShadow = true;
      housing.userData.sensorId = s.id;
      const gland = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.32, r * 0.32, h * 0.45, 16), mat(0x39434a));
      gland.position.y = h + h * 0.22;
      gland.userData.sensorId = s.id;
      group.add(housing, gland);
      if (g.roofOuter) {
        const ro = tankToLocal(m, g.roofOuter[0], g.roofOuter[1], g.roofOuter[2]);
        const len = face[1] - ro[1];
        if (len > 1) {
          const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.78, r * 0.78, len, 24), mat(0xaab6be, { metalness: 0.5 }));
          nozzle.position.y = -len / 2;
          nozzle.castShadow = true;
          group.add(nozzle);
        }
      }
      const coneGeo = new THREE.ConeGeometry(1, 1, 40, 1, true);
      coneGeo.translate(0, -0.5, 0);
      const beam = new THREE.Mesh(
        coneGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
      );
      beam.renderOrder = 6;
      const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]);
      const beamLine = new THREE.Line(
        lineGeo,
        new THREE.LineDashedMaterial({ color, dashSize: r * 0.5, gapSize: r * 0.35, transparent: true, opacity: 0.9 }),
      );
      beamLine.computeLineDistances();
      const hit = new THREE.Mesh(
        new THREE.RingGeometry(r * 0.35, r * 0.6, 32),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }),
      );
      hit.rotation.x = -Math.PI / 2;
      hit.renderOrder = 7;
      group.add(beam, beamLine, hit);
      obj.beam = beam;
      obj.beamLine = beamLine;
      obj.hit = hit;
      obj.label.position.set(0, h * 1.9, 0);
    } else if (s.kind === 'switch') {
      const float = new THREE.Mesh(new THREE.SphereGeometry(r * 0.55, 24, 16), mat(color, { emissiveIntensity: 0 }));
      float.userData.sensorId = s.id;
      float.castShadow = true;
      group.add(float);
      obj.float = float;
      if (g.roofOuter) {
        const ro = tankToLocal(m, g.roofOuter[0], g.roofOuter[1], g.roofOuter[2]);
        group.add(this.cable(ro[1] - face[1], sv.color));
      }
      obj.label.position.set(r * 1.6, 0, 0);
    } else {
      const probe = s.kind === 'submersible';
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(probe ? r * 0.38 : r * 0.55, probe ? r * 1.8 : r * 0.7, 6, 18),
        mat(color),
      );
      body.position.y = probe ? r * 1.3 : r * 0.55;
      body.userData.sensorId = s.id;
      body.castShadow = true;
      group.add(body);
      if (probe && g.roofOuter) {
        const ro = tankToLocal(m, g.roofOuter[0], g.roofOuter[1], g.roofOuter[2]);
        const c = this.cable(ro[1] - face[1] - r * 2.2, sv.color);
        c.position.y = r * 2.2;
        group.add(c);
      }
      const headGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]);
      const head = new THREE.Line(
        headGeo,
        new THREE.LineDashedMaterial({ color, dashSize: r * 0.4, gapSize: r * 0.3, transparent: true, opacity: 0.9 }),
      );
      head.computeLineDistances();
      group.add(head);
      obj.head = head;
      obj.label.position.set(r * 1.7, r * 0.8, 0);
    }
    group.add(obj.label);
    this.sensorGroup.add(group);
    return obj;
  }

  /** Neck (collar) from the roof up to the cover, and the cover with its flange. */
  private buildManhole(mg: ManholeGeom): THREE.Group {
    const m = this.d!.model;
    const mh = mg.manhole;
    const mat = this.mats.manhole;
    const group = new THREE.Group();
    // Sink the neck into the roof a little so it meets a curved roof without a gap.
    const bottom = mg.baseUp - Math.max(m.t.shell, 2) * 0.5;
    const p = tankToLocal(m, ...planToTank(m, mh.x, mh.y, bottom));
    group.position.set(p[0], p[1], p[2]);
    const [hx, hy] = manholeHalf(mh);
    const wall = Math.max(m.t.shell, 3);
    const cover = Math.max(mh.cover, 2);
    const flange = Math.max(25, 0.08 * Math.max(hx, hy)) + wall;
    const neckTop = Math.max(mg.coverUp - cover - bottom, 0);
    const add = (geo: THREE.BufferGeometry, y: number) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = y;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    if (mh.shape === 'round') {
      if (neckTop > 0.5) {
        const profile = [
          new THREE.Vector2(hx, 0),
          new THREE.Vector2(hx + wall, 0),
          new THREE.Vector2(hx + wall, neckTop),
          new THREE.Vector2(hx, neckTop),
          new THREE.Vector2(hx, 0),
        ];
        add(new THREE.LatheGeometry(profile, 48), 0);
      }
      add(new THREE.CylinderGeometry(hx + flange, hx + flange, cover, 48), neckTop + cover / 2);
    } else {
      if (neckTop > 0.5) {
        // Four plates: two along X, two along Y (local z = −plan Y).
        add(new THREE.BoxGeometry(2 * (hx + wall), neckTop, wall), neckTop / 2).position.z = hy + wall / 2;
        add(new THREE.BoxGeometry(2 * (hx + wall), neckTop, wall), neckTop / 2).position.z = -(hy + wall / 2);
        add(new THREE.BoxGeometry(wall, neckTop, 2 * hy), neckTop / 2).position.x = hx + wall / 2;
        add(new THREE.BoxGeometry(wall, neckTop, 2 * hy), neckTop / 2).position.x = -(hx + wall / 2);
      }
      add(new THREE.BoxGeometry(2 * (hx + flange), cover, 2 * (hy + flange)), neckTop + cover / 2);
    }
    return group;
  }

  private cable(length: number, color: string): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, Math.max(length, 0), 0)]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
  }

  private makeTag(tag: string, color: string): CSS2DObject {
    const el = document.createElement('div');
    el.className = 'isa-tag';
    el.style.setProperty('--tag-color', color);
    const [fn, ...rest] = tag.split('-');
    const top = document.createElement('span');
    top.className = 'isa-fn';
    top.textContent = rest.length ? fn : tag;
    const bottom = document.createElement('span');
    bottom.className = 'isa-loop';
    bottom.textContent = rest.join('-');
    el.append(top, bottom);
    if (!rest.length) el.classList.add('single');
    const o = new CSS2DObject(el);
    o.center.set(0.5, 1);
    return o;
  }

  private highlight() {
    for (const s of this.sensors) {
      const on = s.id === this.selected;
      for (const m of s.mats) {
        if (s.float && m === s.float.material) continue;
        m.emissiveIntensity = on ? 0.45 : 0;
      }
      s.label.element.classList.toggle('is-selected', on);
    }
  }

  private buildDims() {
    for (const c of [...this.dimGroup.children]) {
      c.removeFromParent();
      removeLabels(c);
      disposeTree(c);
    }
    if (!this.d || !this.geo) return;
    const m = this.d.model;
    const box = this.geo.outerBox;
    const gap = Math.max(m.size * 0.07, 60);
    const tick = Math.max(m.size * 0.012, 12);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x5f7380, transparent: true, opacity: 0.95 });
    const z = 0;
    const dim = (a: THREE.Vector3, b: THREE.Vector3, text: string, offset: THREE.Vector3) => {
      const pts = [a, b];
      const dir = b.clone().sub(a).normalize();
      const nrm = new THREE.Vector3(-dir.y, dir.x, 0);
      const slash = dir.clone().add(nrm).normalize().multiplyScalar(tick);
      for (const p of [a, b]) pts.push(p.clone().sub(slash), p.clone().add(slash));
      const ext = (p: THREE.Vector3) => [p.clone().sub(offset.clone().setLength(gap * 0.25)), p.clone().sub(offset.clone().setLength(gap * 1.05))];
      const [e1a, e1b] = ext(a);
      const [e2a, e2b] = ext(b);
      const segs = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], e1a, e1b, e2a, e2b]);
      this.dimGroup.add(new THREE.LineSegments(segs, lineMat));
      const el = document.createElement('div');
      el.className = 'dim-label';
      el.textContent = text;
      const lab = new CSS2DObject(el);
      lab.position.copy(a.clone().add(b).multiplyScalar(0.5));
      this.dimGroup.add(lab);
    };
    const u = this.unit;
    const f = (mm: number) => fmtLen(mm, u, true, u === 'mm' ? 0 : undefined);
    if (this.d.kind === 'pit') {
      // Inside sizes of the storage: wall height above the deepest point, and the plan box.
      const pit = this.d.pit;
      const x = box.min.x - gap;
      dim(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, pit.wallTop, z), f(pit.wallTop), new THREE.Vector3(-1, 0, 0));
      const y = box.max.y + gap;
      dim(new THREE.Vector3(pit.box.x0, y, z), new THREE.Vector3(pit.box.x1, y, z), `${f(pit.box.x1 - pit.box.x0)} × ${f(pit.box.y1 - pit.box.y0)} inside`, new THREE.Vector3(0, 1, 0));
    } else if (m.orientation === 'vertical') {
      const x = box.min.x - gap;
      dim(new THREE.Vector3(x, box.min.y, z), new THREE.Vector3(x, box.max.y, z), f(box.max.y - box.min.y), new THREE.Vector3(-1, 0, 0));
      const y = box.max.y + gap;
      const w = box.max.x - box.min.x;
      const wText = m.bodyType === 'cylinder' || m.bodyType === 'sphere' ? `Ø ${f(w)}` : `${f(w)} × ${f(m.outer.depth)}`;
      dim(new THREE.Vector3(box.min.x, y, z), new THREE.Vector3(box.max.x, y, z), wText, new THREE.Vector3(0, 1, 0));
    } else {
      const y = box.max.y + gap;
      dim(new THREE.Vector3(box.min.x, y, z), new THREE.Vector3(box.max.x, y, z), f(box.max.x - box.min.x), new THREE.Vector3(0, 1, 0));
      const x = box.min.x - gap;
      const h = box.max.y - box.min.y;
      const hText = m.bodyType === 'cylinder' ? `Ø ${f(h)}` : f(h);
      dim(new THREE.Vector3(x, box.min.y, z), new THREE.Vector3(x, box.max.y, z), hText, new THREE.Vector3(-1, 0, 0));
    }
  }

  private updateLevelVisuals() {
    const d = this.d;
    if (!d || !this.geo) return;
    const m = d.model;
    const e = d.engine;
    const level = Math.min(Math.max(this.level, 0), e.depth);
    const h = e.hMin + level;
    // World height of the liquid plane, from a point on it.
    const n = e.axis === -1 ? [1, 0, 0] : e.axis === 0 ? [e.na, e.nw, 0] : [e.na, 0, e.nw];
    const p = tankToLocal(m, n[0] * h, n[1] * h, n[2] * h);
    const pw = this.toWorld(p);
    const show = this.view.mode !== 'solid' && level > 0;
    this.waterPlane.constant = level >= e.depth - 1e-9 ? pw.y + 1 : pw.y;

    if (this.surface) {
      this.surface.geometry.dispose();
      this.surface.removeFromParent();
      this.surface = null;
    }
    if (show && level < e.depth - 1e-6) {
      const g = d.kind === 'pit' ? buildPitSurface(d.pit, level) : this.geo.outline ? buildSurface(m, d.engine, this.geo.outline, h) : null;
      if (g) {
        this.surface = new THREE.Mesh(g, this.mats.surface);
        this.surface.renderOrder = 5;
        this.tank.add(this.surface);
      }
    }
    for (const k of ['waterBack', 'waterFront', 'waterCut']) {
      const mesh = this.meshes[k];
      if (mesh) mesh.visible = show && (k !== 'waterCut' || this.view.mode === 'cutaway');
    }
  }

  private applyView() {
    const v = this.view;
    const cut = v.mode === 'cutaway';
    const xray = v.mode === 'xray';
    const outer = this.mats.outer as THREE.MeshStandardMaterial;
    outer.clippingPlanes = cut ? [this.cutPlane] : [];
    outer.transparent = xray;
    outer.opacity = xray ? 0.2 : 1;
    outer.depthWrite = !xray;
    outer.needsUpdate = true;
    if (this.meshes.outer) this.meshes.outer.renderOrder = xray ? 8 : 0;
    const water = [this.mats.waterBack, this.mats.waterFront] as THREE.MeshPhysicalMaterial[];
    for (const w of water) {
      w.clippingPlanes = cut ? [this.waterPlane, this.cutPlane] : [this.waterPlane];
      w.needsUpdate = true;
    }
    const surf = this.mats.surface as THREE.MeshPhysicalMaterial;
    surf.clippingPlanes = cut ? [this.cutPlane] : [];
    surf.needsUpdate = true;
    const mhMat = this.mats.manhole as THREE.MeshStandardMaterial;
    mhMat.clippingPlanes = cut ? [this.cutPlane] : [];
    mhMat.transparent = xray;
    mhMat.opacity = xray ? 0.25 : 1;
    mhMat.depthWrite = !xray;
    mhMat.needsUpdate = true;
    if (this.meshes.innerWall) this.meshes.innerWall.visible = cut;
    if (this.meshes.wallCut) this.meshes.wallCut.visible = cut;
    if (this.meshes.waterCut) this.meshes.waterCut.visible = cut;
    if (this.meshes.sectionEdges) this.meshes.sectionEdges.visible = cut;
    if (this.grid) this.grid.visible = v.grid;
    this.dimGroup.visible = v.dims;
    for (const s of this.sensors) {
      const ghost = cut && s.front;
      for (const m of s.mats) {
        m.transparent = ghost;
        m.opacity = ghost ? 0.35 : 1;
        m.depthWrite = !ghost;
      }
      s.label.element.classList.toggle('is-ghost', ghost);
      if (s.beam) s.beam.visible = v.beams;
      if (s.beamLine) s.beamLine.visible = v.beams;
      if (s.hit) s.hit.visible = v.beams;
      if (s.head) s.head.visible = v.beams;
      s.label.visible = v.labels;
    }
    this.labels.domElement.classList.toggle('hide-tags', !v.labels);
  }

  private resize() {
    const w = Math.max(this.host.clientWidth, 1);
    const h = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private loop = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    const moved = this.controls.update();
    if (moved || this.dirty) {
      this.dirty = false;
      this.render();
    }
  };

  private downAt: { x: number; y: number } | null = null;
  private onPointerDown = (ev: PointerEvent) => {
    this.downAt = { x: ev.clientX, y: ev.clientY };
  };
  private onPointerUp = (ev: PointerEvent) => {
    if (!this.downAt) return;
    const moved = Math.hypot(ev.clientX - this.downAt.x, ev.clientY - this.downAt.y);
    this.downAt = null;
    if (moved > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    this.sensorGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.userData.sensorId) targets.push(o);
    });
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) {
      // Another tank of the site: edit that one.
      const others: THREE.Object3D[] = [];
      this.siteGroup.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.userData.tankIndex !== undefined) others.push(o);
      });
      const tankHit = ray.intersectObjects(others, false)[0];
      if (tankHit) {
        this.onSelectTank?.(tankHit.object.userData.tankIndex as number);
        return;
      }
    }
    this.onSelectSensor?.(hit ? (hit.object.userData.sensorId as string) : null);
  };
}

/** CSS2D labels keep their DOM element when an ancestor is removed, so drop them explicitly. */
function removeLabels(o: THREE.Object3D) {
  o.traverse((c) => {
    if (c instanceof CSS2DObject) c.element.remove();
  });
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}

function niceGrid(span: number): { size: number; cell: number } {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
  const cell = steps.find((s) => span / s <= 40) ?? 50;
  return { size: Math.ceil(span / cell) * cell, cell };
}

/** Section hatching for cut walls, as on an engineering drawing. */
function hatchTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d7dee3';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#3d4b55';
  g.lineWidth = 5;
  for (let i = -64; i <= 128; i += 21) {
    g.beginPath();
    g.moveTo(i, 64);
    g.lineTo(i + 64, 0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
