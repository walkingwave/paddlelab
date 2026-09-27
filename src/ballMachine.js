import * as THREE from 'three';
import { TABLE, NET, BALL, COLORS, PHYSICS, PLAY_AREA } from './constants.js';
import { createHeldServePosition } from './serve.js';

// Robot ball machine at the far end of the table. This is the "trainer" part
// of the app: it aims at a chosen spot on the player's half and launches with
// a drill-specific spin.
//
// Spin convention, for a ball travelling toward the player (+Z):
//   ω = +X  topspin   — Magnus pushes the flight down, the bounce kicks on
//   ω = −X  backspin  — the ball floats, then checks up off the bounce
//   ω = ±Y  sidespin  — curves left or right and skids sideways on landing

// `drill`    fixed spin and pace, machine parked centre — learn one stroke
// `infinite` machine roams the baseline and randomises everything
// `target`   machine steps aside and feeds the ball up in front of you, to be
//            driven at a target pad on the far half
export const MODES = [
  { name: 'Topspin drive', type: 'drill', spin: 190, axis: 'x', speed: 5.0, interval: 2.2 },
  { name: 'Backspin push', type: 'drill', spin: -150, axis: 'x', speed: 4.0, interval: 2.6 },
  { name: 'Flat block', type: 'drill', spin: 0, axis: 'x', speed: 4.6, interval: 2.0 },
  { name: 'Sidespin mix', type: 'drill', spin: 170, axis: 'y', speed: 4.6, interval: 2.4 },
  {
    name: 'Infinite',
    type: 'infinite',
    roam: true,
    speedRange: [3.8, 5.8],
    spinRange: [-230, 230],
    intervalRange: [1.3, 2.4],
    spread: 0.62,
  },
  { name: 'Target practice', type: 'target', interval: 3.0, feedHeight: 0.55 },
  // Rally: the machine puts one ball in play and then goes quiet. From there
  // the opponent keeps it going, so the interval only governs how quickly a
  // dead rally is restarted.
  {
    name: 'Rally',
    type: 'rally',
    spin: 90,
    axis: 'x',
    speed: 4.4,
    interval: 2.4,
    spread: 0.34,
  },
];

const MUZZLE_HEIGHT = TABLE.HEIGHT + 0.26;
const BASELINE_TRAVEL = TABLE.WIDTH / 2 + 0.25; // how far the machine roams

const _target = new THREE.Vector3();
const _flat = new THREE.Vector3();

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

export class BallMachine {
  constructor(balls, settings) {
    this.balls = balls; // pooled Ball instances
    this.settings = settings;
    this.server = null; // set to the opponent, who serves in rally mode
    this.coachActive = false; // true while the Coach game is running
    this.enabled = true;
    this.spread = 0.5; // lateral spread of the target point (m)
    this.modeIndex = 0;
    this.servedCount = 0;

    this._timer = 1.2; // small delay before the first serve
    this._flash = 0; // indicator lamp decay
    this._wheelSpin = 0;
    this._roamTarget = 0; // x the machine is currently sliding toward
    this._roamTimer = 0;

    this.mesh = buildMachineMesh();
    this.mesh.position.set(0, 0, PLAY_AREA.SERVER_Z);
    this._head = this.mesh.getObjectByName('head');
    this._wheels = [
      this.mesh.getObjectByName('wheel-l'),
      this.mesh.getObjectByName('wheel-r'),
    ];
    this._lamp = this.mesh.getObjectByName('lamp');

    this.aim = new THREE.Vector3(0, TABLE.HEIGHT, TABLE.LENGTH / 4);
  }

  // Clamped, because an out-of-range index does not fail quietly: every
  // `mode.type` read throws, which kills the whole frame loop. The list has
  // already changed length once (Coach moved out to its own game), and
  // anything holding a stale index would have taken the game down with it.
  get mode() {
    const i = Math.min(Math.max(this.modeIndex | 0, 0), MODES.length - 1);
    if (i !== this.modeIndex) this.modeIndex = i;
    return MODES[i];
  }

  // Kept as `drill` for the HUD's benefit — it only ever wants the name.
  get drill() {
    return this.mode;
  }

  nextDrill() {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    this._timer = Math.min(this._timer, 1.0);
    return this.mode;
  }

  get isTargetMode() {
    return !this.coachActive && this.mode.type === 'target';
  }

  // Coach suspends the arcade entirely. Without this the rally opponent
  // stayed live during a lesson — standing at the far end and swinging —
  // because the arcade mode underneath was still set to rally.
  get isRallyMode() {
    return !this.coachActive && this.mode.type === 'rally';
  }

  // Coach is a separate game rather than one of the rotating arcade modes,
  // so the machine is told to stand down from outside.
  get isCoachMode() {
    return this.coachActive === true;
  }

  update(dt) {
    this._updateRoaming(dt);

    // Head tracks wherever the next ball is going
    if (this._head) {
      _flat.copy(this.aim);
      this._head.lookAt(_flat);
    }

    // Wheels idle-spin while armed and spike right after a shot
    const wheelRate = this.enabled && !this.isTargetMode ? 14 + this._flash * 60 : 0;
    this._wheelSpin += wheelRate * dt;
    for (const w of this._wheels) if (w) w.rotation.y = this._wheelSpin;

    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 3);
    }
    if (this._lamp) {
      this._lamp.material.emissiveIntensity = this.enabled
        ? 0.4 + this._flash * 2.5
        : 0.05;
      this._lamp.material.emissive.setHex(
        this.enabled ? COLORS.ACCENT : 0x802020
      );
    }

    if (!this.enabled) return;

    // Coach mode drives its own lesson; the machine never fires here. Left
    // to run, it launched from a mode entry with no spin or speed defined,
    // which served a ball with an undefined velocity — NaN through the
    // physics, and then a thrown error the moment the audio layer was handed
    // the result.
    if (this.isCoachMode) return;

    // In rally mode the opponent sustains the exchange; the machine only
    // steps in to restart once the ball is dead.
    if (this.isRallyMode && this.balls.some((b) => b.active)) {
      this._timer = this._nextInterval();
      return;
    }

    this._timer -= dt;
    if (this._timer <= 0) {
      this._timer = this._nextInterval();
      this.serve();
    }
  }

  // Settings are multipliers on whatever the mode specifies, so changing
  // them adjusts the challenge without flattening each mode's character.
  _setting(key, fallback = 1) {
    return this.settings?.get(key) ?? fallback;
  }

  _nextInterval() {
    const mode = this.mode;
    const base = mode.intervalRange ? rand(...mode.intervalRange) : mode.interval;
    return base * this._setting('feedRate');
  }

  // In infinite mode the machine slides along the baseline, so shots arrive
  // from a different angle each time instead of always down the same line.
  // In target mode it parks off to the side, out of the firing line.
  _updateRoaming(dt) {
    const mode = this.mode;
    let desiredX = 0;
    let desiredZ = PLAY_AREA.SERVER_Z;

    if (mode.roam) {
      this._roamTimer -= dt;
      if (this._roamTimer <= 0) {
        this._roamTimer = rand(1.5, 3.5);
        this._roamTarget = rand(-BASELINE_TRAVEL, BASELINE_TRAVEL);
      }
      desiredX = this._roamTarget;
    } else if (this.isTargetMode || this.isRallyMode || this.isCoachMode) {
      // Stand aside: in target mode it is not firing down the line, and in
      // rally mode the opponent plays from roughly where it parks.
      desiredX = BASELINE_TRAVEL + 0.45;
      desiredZ = PLAY_AREA.SERVER_Z - 0.1;
    }

    // Damped move so it glides rather than teleporting
    const k = Math.min(1, dt * 1.6);
    this.mesh.position.x += (desiredX - this.mesh.position.x) * k;
    this.mesh.position.z += (desiredZ - this.mesh.position.z) * k;
  }

  serve() {
    const ball = this.balls.find((b) => !b.active);
    if (!ball) return; // pool exhausted; a ball will free up shortly

    // A rally starts with the player's serve. Keep the ball hovering at the
    // same spot until it is struck; scripted opponent serves made mouse and
    // camera play feel like the point had already begun without the player.
    if (this.isRallyMode) {
      this._holdServeForPlayer(ball);
      this.servedCount++;
      return;
    }

    if (this.isTargetMode) {
      this._feedToPlayer(ball);
    } else {
      this._launch(ball);
    }

    this.servedCount++;
    this._flash = 1;
  }

  _launch(ball) {
    const mode = this.mode;

    // Aim at a point on the player's half, short of the end line. The spread
    // has to be clamped to the table: a wide mode multiplied by the Wide
    // placement setting otherwise targets past the side line, and a ball
    // aimed off the table is unhittable and scores as a miss through no
    // fault of the player.
    const maxSpread = TABLE.WIDTH / 2 - BALL.RADIUS - 0.04;
    const spread = Math.min(
      (mode.spread ?? this.spread) * this._setting('placement'),
      maxSpread
    );

    _target.set(
      (Math.random() * 2 - 1) * spread,
      TABLE.HEIGHT + BALL.RADIUS,
      TABLE.LENGTH * 0.18 + Math.random() * TABLE.LENGTH * 0.22
    );
    this.aim.copy(_target);

    const origin = new THREE.Vector3(
      this.mesh.position.x,
      MUZZLE_HEIGHT,
      this.mesh.position.z + 0.12
    );

    // Infinite mode rolls fresh spin and pace for every ball, including the
    // spin axis, so you can't settle into one stroke.
    // Defaults, so a mode that omits these cannot serve a NaN ball. Adding
    // a mode without them is an easy mistake to make — this file just made
    // it — and the failure lands far away, in the audio layer.
    let spinAmount = mode.spin ?? 0;
    let axis = mode.axis ?? 'x';
    let speed = mode.speed ?? 4.5;
    // Only Infinite overrides them; every other mode keeps the defaults
    // above. Reassigning the raw fields in an else branch here undid the
    // guard completely, which is how a mode with no spin or speed served a
    // NaN ball in the first place.
    if (mode.type === 'infinite') {
      spinAmount = rand(...mode.spinRange);
      axis = Math.random() < 0.35 ? 'y' : 'x';
      speed = rand(...mode.speedRange);
    }

    const spin = new THREE.Vector3();
    if (axis === 'y') {
      spin.set(0, spinAmount, 0);
    } else {
      spin.set(spinAmount, 0, 0);
    }

    const velocity = solveLaunch(origin, _target, speed * this._setting('pace'), spin);
    ball.serve(origin, velocity, spin);
  }

  _holdServeForPlayer(ball) {
    const origin = createHeldServePosition();
    this.aim.copy(origin);
    ball.holdForServe(origin);
  }

  // Target mode: lob the ball gently upward just in front of the player so
  // they can take a full swing at it. A near-vertical toss gives a wide
  // timing window, which is what makes this a placement drill rather than a
  // reaction one.
  _feedToPlayer(ball) {
    const mode = this.mode;
    const origin = new THREE.Vector3(
      rand(-0.28, 0.28),
      TABLE.HEIGHT + 0.06,
      PLAY_AREA.PLAYER_Z - 0.62
    );

    // Toss height sets the hang time: v = sqrt(2·g·h)
    const up = Math.sqrt(2 * 9.81 * mode.feedHeight);
    const velocity = new THREE.Vector3(rand(-0.06, 0.06), up, rand(-0.12, 0.02));

    this.aim.copy(origin);
    ball.serve(origin, velocity, new THREE.Vector3(0, 0, 0));
    ball.isFeed = true;
  }
}

// --- Launch solver ----------------------------------------------------------
// A closed-form ballistic solve is wrong here: drag takes metres off the
// range, and Magnus bends the flight hard enough that a topspin shot aimed
// analytically dives straight into the net. So aim by simulating the same
// forces the physics step applies, then correct and repeat.
//
// Two coupled corrections run together — horizontal speed scales toward the
// target range, and launch elevation rises until the ball clears the net with
// margin. A handful of iterations is plenty, and it only runs once per serve.

const SOLVER_ITERATIONS = 8;
const NET_MARGIN = 0.055; // metres of air over the tape
// How much of the remaining aiming error each solver pass corrects. Full
// correction overshoots — the Magnus curve is curved, so a sidespin ball's
// sideways error is not proportional to the aim change — while a small
// fraction does not converge inside the iteration budget.
const AIM_CORRECTION = 0.6;

// Flies a trial shot and reports where it lands and how close it came to the
// net tape. Mirrors the integration in PhysicsWorld.
// The flight model is shared with the coach and the rally opponent through
// ballistics.js. A second copy here is how a "solved" shot ends up landing
// somewhere else: this one detected the net crossing in one direction only,
// which happened to be right for the machine and wrong for everything else.
import { flyShot as simulateShot } from './ballistics.js';
export { simulateShot };

export function solveLaunch(origin, target, speed, spin) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const range = Math.hypot(dx, dz);
  // Aiming at the muzzle leaves no direction to point in, and dividing by
  // that would hand back a vector of NaNs that poisons everything downstream.
  // The machine never does this in play — it always targets the far half — but
  // the solver should degrade rather than produce nonsense.
  if (range < 1e-6) return new THREE.Vector3();

  // The point the launch is actually aimed at. It starts at the target and is
  // nudged each pass, because scaling the speed along a fixed line cannot fix
  // a shot that curves sideways: Magnus pushes a sidespin ball across the
  // table, and it landed most of a metre wide of where it was pointed.
  let aimX = dx;
  let aimZ = dz;

  // Opening guess: plain ballistics, but with gravity bumped by the Magnus
  // term topspin contributes, so the first trial is already in the region.
  const T = range / speed;
  const gEff = 9.81 + PHYSICS.MAGNUS * spin.x * speed;
  let horizontalSpeed = speed;
  let vy = (dy + 0.5 * gEff * T * T) / T;

  const velocity = new THREE.Vector3();

  for (let i = 0; i < SOLVER_ITERATIONS; i++) {
    const aimRange = Math.hypot(aimX, aimZ);
    if (aimRange < 1e-6) break;
    velocity.set(
      (aimX / aimRange) * horizontalSpeed,
      vy,
      (aimZ / aimRange) * horizontalSpeed
    );
    const shot = simulateShot(origin, velocity, target.y, spin);

    if (shot.netClearance < NET_MARGIN) {
      // Too flat — lift the launch until it clears the tape.
      vy += (NET_MARGIN - shot.netClearance) * 2.4 + 0.05;
      continue;
    }

    const ex = shot.x - origin.x;
    const ez = shot.z - origin.z;
    const flown = Math.hypot(ex, ez);
    if (!shot.landed || flown < 1e-3) break;

    // How far the ball landed from where it was pointed, in the table plane.
    const missX = target.x - shot.x;
    const missZ = target.z - shot.z;
    if (Math.hypot(missX, missZ) < 0.01) break;

    aimX += missX * AIM_CORRECTION;
    aimZ += missZ * AIM_CORRECTION;
    horizontalSpeed *= THREE.MathUtils.clamp(range / flown, 0.75, 1.35);
  }

  const aimRange = Math.hypot(aimX, aimZ);
  if (aimRange < 1e-6) return new THREE.Vector3();
  return velocity.set(
    (aimX / aimRange) * horizontalSpeed,
    vy,
    (aimZ / aimRange) * horizontalSpeed
  );
}


// The machine, built to read as a piece of sports equipment rather than a
// box on a post. What sells it is the mechanism being legible: a tripod you
// could actually stand up, a hopper that feeds into something, a turret that
// visibly aims, and the two friction wheels the ball is squeezed between.
//
// Named parts the game animates: `head` (pitches toward the aim point),
// `wheel-l` / `wheel-r` (spin up), `lamp` (armed indicator).

const COLUMN_TOP = MUZZLE_HEIGHT - 0.1;

function buildMachineMesh() {
  const group = new THREE.Group();

  const shell = new THREE.MeshStandardMaterial({
    color: 0x2b2f36,
    roughness: 0.42,
    metalness: 0.45,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x111318,
    roughness: 0.66,
    metalness: 0.25,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x0c0d10,
    roughness: 0.95,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: COLORS.ACCENT,
    roughness: 0.35,
    metalness: 0.25,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x7d858f,
    roughness: 0.3,
    metalness: 0.8,
  });

  // --- Tripod -------------------------------------------------------------
  // Three splayed legs read as something that stands up on its own; the
  // single post it replaces looked like a signpost.
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.065, 0.05, 16),
    shell
  );
  hub.position.y = 0.30;
  hub.castShadow = true;
  group.add(hub);

  const legGeo = new THREE.CylinderGeometry(0.014, 0.018, 0.42, 10);
  const footGeo = new THREE.CylinderGeometry(0.026, 0.03, 0.016, 12);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const spread = 0.26;

    const leg = new THREE.Mesh(legGeo, steel);
    leg.position.set(Math.cos(a) * spread * 0.5, 0.15, Math.sin(a) * spread * 0.5);
    // Splay outward: tilt away from the column by a fixed angle
    leg.rotation.z = -Math.cos(a) * 0.5;
    leg.rotation.x = Math.sin(a) * 0.5;
    leg.castShadow = true;
    group.add(leg);

    const foot = new THREE.Mesh(footGeo, rubber);
    foot.position.set(Math.cos(a) * spread, 0.008, Math.sin(a) * spread);
    group.add(foot);
  }

  // --- Column, in two stages with a clamp, like a real stand --------------
  const lower = new THREE.Mesh(
    new THREE.CylinderGeometry(0.036, 0.042, 0.26, 16),
    shell
  );
  lower.position.y = 0.42;
  lower.castShadow = true;
  group.add(lower);

  const clamp = new THREE.Mesh(
    new THREE.CylinderGeometry(0.044, 0.044, 0.035, 16),
    dark
  );
  clamp.position.y = 0.55;
  group.add(clamp);

  const clampLever = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.012, 0.014),
    accent
  );
  clampLever.position.set(0.05, 0.55, 0);
  group.add(clampLever);

  const upper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, COLUMN_TOP - 0.55, 16),
    steel
  );
  upper.position.y = 0.55 + (COLUMN_TOP - 0.55) / 2;
  upper.castShadow = true;
  group.add(upper);

  // --- Body shell ---------------------------------------------------------
  const body = new THREE.Mesh(
    roundedBox(0.34, 0.28, 0.26, 0.035),
    shell
  );
  body.position.y = MUZZLE_HEIGHT;
  body.castShadow = true;
  group.add(body);

  // Panel line and accent band, so the shell isn't one undifferentiated mass
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.352, 0.018, 0.272), accent);
  band.position.y = MUZZLE_HEIGHT + 0.088;
  group.add(band);

  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.09, 0.14), dark);
  for (const sx of [-1, 1]) {
    const v = vent.clone();
    v.position.set(sx * 0.172, MUZZLE_HEIGHT - 0.02, 0);
    group.add(v);
  }

  // Control panel on the back, angled up toward whoever is loading it
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.02, 0.1), dark);
  panel.position.set(0, MUZZLE_HEIGHT + 0.03, -0.15);
  panel.rotation.x = -0.5;
  group.add(panel);

  for (let i = 0; i < 3; i++) {
    const btn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.006, 10),
      i === 0 ? accent : steel
    );
    btn.position.set(-0.04 + i * 0.04, MUZZLE_HEIGHT + 0.045, -0.163);
    btn.rotation.x = -0.5 + Math.PI / 2;
    group.add(btn);
  }

  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 14, 10),
    new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      emissive: new THREE.Color(COLORS.ACCENT),
      emissiveIntensity: 0.5,
      roughness: 0.3,
    })
  );
  lamp.name = 'lamp';
  lamp.position.set(0.12, MUZZLE_HEIGHT + 0.088, 0.1);
  group.add(lamp);

  // --- Hopper -------------------------------------------------------------
  // A funnel on a collar, with a rim and struts, so it reads as mounted
  // plumbing rather than a cup left on top of the box.
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.085, 0.03, 20),
    dark
  );
  collar.position.y = MUZZLE_HEIGHT + 0.115;
  group.add(collar);

  const funnel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.155, 0.07, 0.17, 24, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x9aa4b2,
      transparent: true,
      opacity: 0.22,
      roughness: 0.2,
      metalness: 0.1,
      side: THREE.DoubleSide,
    })
  );
  funnel.position.y = MUZZLE_HEIGHT + 0.215;
  group.add(funnel);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.008, 8, 28), steel);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = MUZZLE_HEIGHT + 0.3;
  group.add(rim);

  // Struts from the rim down to the collar
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.18, 6),
      steel
    );
    strut.position.set(
      Math.cos(a) * 0.112,
      MUZZLE_HEIGHT + 0.215,
      Math.sin(a) * 0.112
    );
    strut.rotation.z = Math.cos(a) * 0.26;
    strut.rotation.x = -Math.sin(a) * 0.26;
    group.add(strut);
  }

  const spareGeo = new THREE.SphereGeometry(BALL.RADIUS, 12, 8);
  const spareMat = new THREE.MeshStandardMaterial({
    color: COLORS.BALL,
    roughness: 0.5,
  });
  // Deterministic golden-angle scatter: packed, and never re-shuffles
  for (let i = 0; i < 16; i++) {
    const s = new THREE.Mesh(spareGeo, spareMat);
    const a = i * 2.399;
    const layer = Math.floor(i / 6);
    const rad = 0.03 + (i % 6) * 0.016 + layer * 0.008;
    s.position.set(
      Math.cos(a) * rad,
      MUZZLE_HEIGHT + 0.175 + layer * 0.032,
      Math.sin(a) * rad
    );
    group.add(s);
  }

  // --- Turret -------------------------------------------------------------
  // The head pitches to aim. Object3D.lookAt aims an object's +Z at the
  // target — three swaps the arguments for non-cameras, so it is the
  // opposite of the camera convention — which means everything in here is
  // built along +Z. Built along −Z, as it was, the barrel pointed away from
  // the table and sat buried inside the body.
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, MUZZLE_HEIGHT - 0.005, 0.1);
  group.add(head);

  // Yoke cheeks, so the barrel visibly hangs in a mount rather than being a
  // hole in the shell.
  for (const sx of [-1, 1]) {
    const cheek = new THREE.Mesh(roundedBox(0.02, 0.15, 0.1, 0.028), shell);
    cheek.position.set(sx * 0.082, 0, -0.005);
    cheek.castShadow = true;
    head.add(cheek);

    const pivot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 0.012, 12),
      steel
    );
    pivot.rotation.z = Math.PI / 2;
    pivot.position.set(sx * 0.094, 0, -0.005);
    head.add(pivot);
  }

  // The friction wheels sit proud of the barrel, between the cheeks, where
  // you can actually see them turn. Tucked inside the tube — which is where
  // a real one hides them — the machine loses the one detail that explains
  // how it throws a ball.
  const wheelGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.022, 22);
  const treadGeo = new THREE.TorusGeometry(0.052, 0.007, 8, 24);
  for (const [name, sy] of [
    ['wheel-l', 1],
    ['wheel-r', -1],
  ]) {
    // Holder does the tilting; the wheel spins on its own axis inside it, so
    // the two rotations cannot fight each other.
    const holder = new THREE.Group();
    holder.rotation.z = Math.PI / 2;
    holder.position.set(0, sy * 0.056, -0.01);

    const wheel = new THREE.Mesh(wheelGeo, steel);
    wheel.name = name;
    wheel.castShadow = true;

    const tread = new THREE.Mesh(treadGeo, rubber);
    tread.rotation.x = Math.PI / 2;
    wheel.add(tread);

    // Spokes, so the spin is legible instead of a smooth grey disc
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.024, 0.008),
        dark
      );
      spoke.rotation.y = (i / 3) * Math.PI;
      wheel.add(spoke);
    }

    holder.add(wheel);
    head.add(holder);
  }

  // Short barrel ahead of the wheels, in shell grey so it reads against the
  // dark body instead of disappearing into it.
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.048, 0.055, 0.1, 22, 1, true),
    shell
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = 0.065;
  barrel.castShadow = true;
  head.add(barrel);

  const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.0105, 12, 26), accent);
  muzzle.position.z = 0.115;
  head.add(muzzle);

  // Dark throat inside the muzzle, so it reads as an opening
  const throat = new THREE.Mesh(
    new THREE.CircleGeometry(0.044, 22),
    new THREE.MeshBasicMaterial({ color: 0x05060a })
  );
  throat.position.z = 0.112;
  head.add(throat);

  // Feed tube from the hopper collar into the back of the turret
  const feed = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.026, 0.12, 12),
    dark
  );
  feed.position.set(0, MUZZLE_HEIGHT + 0.07, 0.07);
  feed.rotation.x = 0.5;
  group.add(feed);

  return group;
}

// A box with softened edges. Plain BoxGeometry catches light along a hard
// seam that reads as untextured geometry; a small bevel is most of what
// makes a shell look moulded.
function roundedBox(width, height, depth, radius) {
  const shape = new THREE.Shape();
  const w = width / 2 - radius;
  const h = height / 2 - radius;
  shape.moveTo(-w, -height / 2);
  shape.lineTo(w, -height / 2);
  shape.quadraticCurveTo(width / 2, -height / 2, width / 2, -h);
  shape.lineTo(width / 2, h);
  shape.quadraticCurveTo(width / 2, height / 2, w, height / 2);
  shape.lineTo(-w, height / 2);
  shape.quadraticCurveTo(-width / 2, height / 2, -width / 2, h);
  shape.lineTo(-width / 2, -h);
  shape.quadraticCurveTo(-width / 2, -height / 2, -w, -height / 2);
  shape.closePath();

  const bevel = Math.min(radius * 0.6, depth * 0.22);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geo.translate(0, 0, -(depth - bevel * 2) / 2);
  return geo;
}
