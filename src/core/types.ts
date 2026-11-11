import type { FlowUnit, LengthUnit, PressureUnit, VolumeUnit } from './units';

/** All lengths in the configuration are stored in millimetres, pressures in pascal. */

export type Orientation = 'vertical' | 'horizontal';

export type BodyType =
  | 'cylinder'
  | 'oval'
  | 'rect'
  | 'stadium'
  | 'polygon'
  | 'sphere'
  | 'chamfer'
  | 'trapezoid'
  | 'boxoval'
  | 'dshape'
  | 'trough';

export type HeadType =
  | 'flat'
  | 'hemi'
  | 'ellipsoidal'
  | 'torispherical'
  | 'dished'
  | 'cone'
  | 'wedge'
  | 'sloped'
  | 'paraboloid'
  | 'flanged'
  | 'toricone';

export type ToriStandard = 'klopper' | 'korbbogen' | 'asme' | 'r8010' | 'custom' | 'measured';

/**
 * Measured torispherical heads: the measurements that define the head. 'depth' and 'arc'
 * use one measurement, with the knuckle radius taken as `knuckle` × D (0.1 for DIN / Klöpper).
 */
export type ToriBy = 'depth' | 'arc' | 'depth-crown' | 'depth-knuckle' | 'crown-knuckle' | 'arc-depth' | 'arc-crown' | 'arc-knuckle';

export interface HeadConfig {
  type: HeadType;
  /** Semi-ellipsoidal heads: diameter-to-depth style ratio R:h (2 means a standard 2:1 head). */
  ellipseRatio: number;
  /** Semi-ellipsoidal heads: size by the ratio, the head depth or the arc length over the head. */
  ratioBy: 'ratio' | 'depth' | 'arc';
  /** Shallow dome: size by the depth, the dish (sphere) radius or the arc length over the dome. */
  dishBy: 'depth' | 'radius' | 'arc';
  /** Shallow dome dish radius when dishBy = 'radius' (mm, inside). */
  dishRadius: number;
  /** Depth for dished / cone / wedge / sloped heads when sizeBy = 'depth' (mm, measured per the dimension basis). */
  depth: number;
  /** Cone / wedge / slope: specify by wall angle or by depth. */
  sizeBy: 'angle' | 'depth';
  /** Wall angle measured from the flat end plane (deg). 0° = flat, 90° = parallel to the shell. */
  angle: number;
  /** Outlet / flat bottom size: diameter for round bodies, width (u direction) for others (mm). */
  outlet: number;
  /** Second outlet dimension (v direction) for non-round bodies (mm). */
  outlet2: number;
  /** Cone: one side straight (eccentric) instead of centred. */
  eccentric: boolean;
  /** Which side stays straight for eccentric cones and single slopes. */
  side: 'pos' | 'neg';
  /** V-trough axis: slope across the width (u) or across the depth (v). */
  axis: 'u' | 'v';
  tori: ToriStandard;
  /** Custom torispherical crown radius as a fraction of the diameter. */
  crown: number;
  /** Torispherical knuckle radius as a fraction of the diameter: custom radii, and measured heads sized by depth or arc only. */
  knuckle: number;
  /** Measured torispherical heads: which two measurements are given. */
  toriBy: ToriBy;
  /** Measured torispherical crown (dish) radius (mm, measured per the dimension basis). */
  crownR: number;
  /**
   * Knuckle radius (mm, measured per the dimension basis): measured torispherical heads,
   * flanged flat heads and toriconical heads.
   */
  knuckleR: number;
  /** Arc length over the head from one tangent line through the centre to the other (mm, per the dimension basis). */
  arc: number;
  /** Wall thickness of this head (mm). */
  thickness: number;
  /** Same size: the head depth (Z) equals the shell width (X) at this end. Half-oval, paraboloid, cone, V-trough and slope heads only. */
  uniform?: boolean;
}

export interface BodyConfig {
  type: BodyType;
  /** Cylinder and sphere diameter (mm). */
  diameter: number;
  /** Width along u (mm): left-right for vertical tanks, front-back for horizontal tanks. */
  width: number;
  /** Second cross-section size (mm): front-back depth for vertical tanks, height for horizontal tanks. */
  depth: number;
  /** Corner radius for rectangular bodies (mm). */
  corner: number;
  /** Trapezoid: width at the bottom (horizontal) or front (vertical) side; `width` is the top / back (mm). */
  width2: number;
  /** Chamfered box: corner cut at 45°, measured along each side (mm). */
  chamfer: number;
  /** Box-oval (superellipse) exponent: 2 is an oval, higher is closer to a box. */
  squareness: number;
  /** Straight shell length between the two heads (mm). Height for vertical tanks. */
  length: number;
  /** Give the shell size as the diameter / width, or as the circumference (a tape around the shell). */
  sizeBy: 'size' | 'perimeter';
  /** Circumference of the shell at its start, per the dimension basis (mm), used when sizeBy = 'perimeter'. */
  perimeter: number;
  /** Give the length as the straight shell (tangent to tangent) or as the overall length end to end. */
  lengthBy: 'shell' | 'overall';
  /** Overall length (height) including both ends, per the dimension basis (mm), used when lengthBy = 'overall'. */
  overall: number;
  /** Size of the top / right end relative to the bottom / left end (1 = straight shell). */
  endScale: number;
  /** Shell wall thickness (mm). */
  thickness: number;
  /** Polygon bodies: number of sides (6, 8, 10 or 12). */
  sides: number;
  /** Use the custom shell profile (stepped or multi-taper shell) instead of endScale. */
  profileOn: boolean;
  /** Custom shell profile: size of the shell at a distance from the start of the shell. */
  profile: ProfilePoint[];
  /** Same size: width (X), depth (Y) and straight shell length (Z) are all equal to the width (or diameter). */
  uniform?: boolean;
}

export interface ProfilePoint {
  /** Distance from the bottom (vertical) or left end (horizontal) of the straight shell (mm). */
  at: number;
  /** Diameter (round bodies) or width (other bodies) at that point, measured per the dimension basis (mm). */
  size: number;
}

export interface TankConfig {
  /** A closed tank (shell with two ends, the default) or an open concrete storage (pit) designed in plan. */
  kind?: 'tank' | 'pit';
  orientation: Orientation;
  /** Whether the entered dimensions are outside or inside measurements. */
  basis: 'outside' | 'inside';
  body: BodyConfig;
  /** Bottom head for vertical tanks, left end for horizontal tanks. */
  start: HeadConfig;
  /** Top head for vertical tanks, right end for horizontal tanks. */
  end: HeadConfig;
  /** Installation tilt (deg). Vertical: top leans toward +X. Horizontal: right end raised. */
  tilt: number;
  /** Edit both ends together: every shape change applies to both. */
  sameEnds?: boolean;
  /** Manholes (hole doors) on the roof; top sensors can sit on their covers. */
  manholes?: ManholeConfig[];
  /** The concrete storage when kind = 'pit'. */
  pit?: PitConfig;
}

/** A point in the plan (mm). X runs left–right, Y front–back, like the sensor positions. */
export interface PlanPoint {
  x: number;
  y: number;
}

/**
 * How the floor of a concrete storage runs:
 * - flat: level everywhere
 * - plane: one slope, rising along `direction` (deg in the plan, 0 = +X, 90 = +Y) by `drop` mm
 *   from the lowest edge of the outline to the highest
 * - vertices: the floor height is given at every vertex of the outline and interpolated
 *   across it (several slopes, a ridge, a stepped floor drawn with extra vertices)
 */
export type PitFloor =
  | { type: 'flat' }
  | { type: 'plane'; direction: number; drop: number }
  | { type: 'vertices'; heights: number[] };

/** A sump: a rectangular (or polygonal) pit in the floor, `depth` mm below the floor around it. */
export interface PitSump {
  x: number;
  y: number;
  /** Size along X (mm). */
  width: number;
  /** Size along Y (mm). */
  length: number;
  depth: number;
  /** A polygonal sump: its outline replaces the rectangle. */
  outline?: PlanPoint[];
}

/** A capacity from the engineer's drawing at a level (above the drawing's own zero), to check the design against. */
export interface PitCheck {
  level: number;
  litres: number;
}

/**
 * Where the heights on the drawing are measured from:
 * - datum: the deepest point of the floor, sumps included (level zero of the scripts)
 * - floorLow: the lowest point of the main floor (a sump may be deeper)
 * - floorHigh: the highest point of the floor, the shallow end
 */
export type PitHeightRef = 'datum' | 'floorLow' | 'floorHigh';

/**
 * An open concrete storage (asphalt pit, basin, bund): the plan outline of the inner wall
 * faces, the wall height and how the floor slopes. Level zero is the deepest point of the
 * floor; the volume is worked out numerically over the plan.
 */
export interface PitConfig {
  /** Plan outline of the inner wall faces: any simple polygon, vertices in order (mm). */
  outline: PlanPoint[];
  /** Top of the wall above `heightRef` (mm). */
  wallHeight: number;
  heightRef: PitHeightRef;
  floor: PitFloor;
  sumps: PitSump[];
  /** Wall batter: the inner face leans outward by this many mm per metre of height. 0 = vertical. */
  batter: number;
  /** Wall top width, wall base width and floor slab thickness (mm): drawing only, never in the volume. */
  wallTop: number;
  wallBase: number;
  slab: number;
  /** Operation level and alarm levels above `heightRef` (mm), for information. */
  operationLevel: number | null;
  alarmHigh: number | null;
  alarmLow: number | null;
  /** Capacities from the drawing (level above `heightRef`) the design is checked against. */
  checks: PitCheck[];
}

/**
 * A manhole (hole door) on the roof: an opening with a neck (collar) and a cover.
 * Plan position uses the same X / Y as the sensors.
 */
export interface ManholeConfig {
  id: string;
  tag: string;
  x: number;
  y: number;
  shape: 'round' | 'rect';
  /** Round: inside diameter of the opening. Rect: opening size along X (mm). */
  diameter: number;
  /** Rect: opening size along Y (mm). */
  length: number;
  /** Give the cover height as the neck height above the roof, or directly above level zero. */
  heightBy: 'neck' | 'zero';
  /** Neck (collar) height from the outside roof at the manhole centre to the top of the cover (mm). */
  neck: number;
  /** Top of the cover above level zero when heightBy = 'zero' (mm). */
  top: number;
  /** Cover plate thickness (mm). */
  cover: number;
}

export interface LiquidConfig {
  preset: string;
  /** kg/m³ */
  density: number;
}

export interface LevelMarks {
  /** Overflow / maximum fill level above level zero (mm), null when not used. */
  overflow: number | null;
  /** Outlet level above level zero (mm): liquid below it cannot be drawn off. */
  outlet: number | null;
}

export type SensorKind = 'ultrasonic' | 'radar' | 'laser' | 'pressure' | 'submersible' | 'switch';
export type SignalType = 'digital' | 'current' | 'voltage';

export interface SensorConfig {
  id: string;
  tag: string;
  kind: SensorKind;
  enabled: boolean;
  /** Stable colour slot (1–7) so a sensor keeps its colour when others are removed. */
  colorSlot: number;
  /** Plan position (mm). Vertical: X left-right, Y front-back. Horizontal: X along the length from the middle, Y across. */
  x: number;
  y: number;
  /**
   * Top sensors: sensor face height above its mounting surface (mm): the outside roof (a nozzle or
   * stand-pipe) or, on a manhole, the top of the cover (negative when the face hangs below the cover top).
   */
  nozzle: number;
  /** Top sensors: compute the face height from the roof, from a manhole cover, or enter it directly. */
  faceMode: 'auto' | 'manhole' | 'manual';
  /** Id of the manhole the sensor sits on when faceMode = 'manhole'. */
  manhole?: string;
  /** Manual face height above level zero (mm). */
  faceHeight: number;
  /** Blind zone in front of the sensor face (mm). */
  deadBand: number;
  /** Maximum measuring distance (mm). */
  maxRange: number;
  /** Full beam angle (deg). */
  beamAngle: number;
  /** Bottom sensors, probes and switches: sensing point height above the floor below it (mm). */
  elevation: number;
  /** Level switches: alarm when the liquid is above (high) or below (low) the switch. */
  switchMode: 'high' | 'low';
  signal: SignalType;
  /** Unit the sensor reports in when the signal is digital (length or pressure unit). */
  digitalUnit: string;
  /** Digital resolution in canonical units (mm or Pa). */
  resolution: number;
  /** Measurement mapped to the bottom of the signal range (mm or Pa). */
  rangeMin: number;
  /** Measurement mapped to the top of the signal range (mm or Pa). */
  rangeMax: number;
  /** Signal at rangeMin (mA or V). */
  outMin: number;
  /** Signal at rangeMax (mA or V). */
  outMax: number;
  /** Swap the signal direction (rangeMin gives outMax). */
  invert: boolean;
  /** ADC resolution in bits; 0 means the signal is not digitised. */
  adcBits: number;
  /** ADC reference voltage (V). */
  adcVref: number;
  /** Shunt resistor for 4–20 mA loops (Ω). */
  shunt: number;
  /** Voltage divider ratio in front of the ADC (V_adc = V_signal × divider). */
  divider: number;
  /** Simulated noise, one standard deviation, expressed in mm of liquid. */
  noise: number;
  /** Field calibration of the raw value against real measurements. */
  cal: CalConfig;
  /** The IoT device that sends this sensor's readings to Cloud Studio. */
  iot?: IotConfig;
  /** Number of this sensor in the Cloud Studio scripts (its endpoints n1, n2, n3); missing = the next free one. */
  number?: number;
}

/**
 * The device model that sends a sensor's readings, which sets how the Cloud Studio
 * payload script decodes them:
 * - dragino-mr: Dragino MR-03 / MR-12 / MR-25-LB radar (LoRaWAN), distance in mm
 * - dragino-dds: Dragino DDS20-LB / DDS75-LB / DDS45-LB and LDDS ultrasonic (LoRaWAN), distance in mm
 * - tek766: Rochester / Tekelek TEK 766 ultrasonic (LoRaWAN), ullage in cm
 * - tek811: Rochester / Tekelek TEK 811 / 811 LR ultrasonic (4G NB-IoT / CAT-M1), ullage in cm
 * - milesight: Milesight EM310-UDL, EM400-UDL / MUD, EM410-RDL, EM500-UDL, distance in mm
 * - milesight-swl: Milesight EM500-SWL submersible level, depth in cm
 * - netvox: Netvox R718PE / R718X ultrasonic, distance in mm
 * - netvox-pa22: Netvox R718PA22 bottom-mounted ultrasonic, depth in mm
 * - json: JSON text, as SIM card (NB-IoT / 4G) devices send over MQTT or HTTP
 * - parsed: an object decoded by the network server (TTN, ChirpStack, Actility)
 * - bytes: a number at a fixed place in a binary payload (RS485 / Modbus converters and others)
 */
export type IotDevice =
  | 'dragino-mr'
  | 'dragino-dds'
  | 'tek766'
  | 'tek811'
  | 'milesight'
  | 'milesight-swl'
  | 'netvox'
  | 'netvox-pa22'
  | 'json'
  | 'parsed'
  | 'bytes';

export interface IotConfig {
  device: IotDevice;
  /** DevEUIs (LoRaWAN) or IMEIs (SIM card devices), separated by commas, spaces or new lines. */
  addresses: string;
  /** JSON / decoded payloads: path of the reading (dots for nested keys). */
  key: string;
  /** JSON / decoded payloads: path of the battery value (volts up to 5, else %); empty for none. */
  batteryKey: string;
  /** Binary payloads: LoRaWAN port the reading comes on (0 = any). */
  port: number;
  /** Binary payloads: first byte of the reading. */
  offset: number;
  /** Binary payloads: size of the reading in bytes. */
  size: 1 | 2 | 4;
  /** Binary payloads: byte order, big-endian (Modbus) or little-endian. */
  order: 'be' | 'le';
  signed: boolean;
  /** Binary payloads: reading = integer ÷ divisor. */
  divisor: number;
}

/**
 * Cloud Studio settings saved in projects made before a site could hold several tanks:
 * read once to carry the tank number and devices over to the site.
 */
export interface CloudConfig {
  /** Tank number (the start of the tank's endpoint addresses). */
  tank: number;
  model?: IotDevice | 'each';
  iot?: IotConfig;
  devices?: { address: string; tank: string; sensor: string; name: string; number?: number }[];
}

/** One device (one DevEUI) on the site. */
export interface SiteDevice {
  /** DevEUI: hex digits, upper case. */
  address: string;
  /** Number of the sensor it is (its endpoints n1, n2, n3); missing = not chosen yet. */
  number?: number;
}

/**
 * How the raw → level formula is made.
 * - theory: only from the tank drawing and sensor settings
 * - offset: one reference point corrects the zero (offset)
 * - twopoint: two reference points correct zero and span
 * - multipoint: best straight-line fit through many reference points
 */
export type CalMethod = 'theory' | 'offset' | 'twopoint' | 'multipoint';

export interface CalPoint {
  /** Raw value read by the script (unit of the sensor's raw value). */
  raw: number;
  /** True level (mm) or true volume (L), per CalConfig.ref. */
  ref: number;
}

export interface CalConfig {
  method: CalMethod;
  /** What the reference was measured as: a dip / tape level or a metered volume. */
  ref: 'level' | 'volume';
  points: CalPoint[];
}

export interface UnitPrefs {
  length: LengthUnit;
  volume: VolumeUnit;
  pressure: PressureUnit;
  flow: FlowUnit;
}

export interface Project {
  version: 1;
  name: string;
  tank: TankConfig;
  liquid: LiquidConfig;
  marks: LevelMarks;
  sensors: SensorConfig[];
  units: UnitPrefs;
  /** Cloud Studio settings; missing in projects made before they existed. */
  cloud?: CloudConfig;
}

export type ViewMode = 'cutaway' | 'xray' | 'solid';

export interface ViewState {
  mode: ViewMode;
  dims: boolean;
  beams: boolean;
  labels: boolean;
  grid: boolean;
}

export interface SimState {
  /** Current liquid level above level zero (mm). */
  level: number;
  /** Flow magnitude (L/min). */
  flow: number;
  /** 1 filling, -1 draining, 0 paused. */
  direction: -1 | 0 | 1;
  /** Time multiplier. */
  speed: number;
  /** Add simulated noise to readings. */
  noise: boolean;
}
