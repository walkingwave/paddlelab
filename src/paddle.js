import * as THREE from 'three';
import { PADDLE } from './constants.js';

// A flat screen shrinks everything: the paddle covers a fraction of the
// visual field it would in a headset, and the pointer/camera inputs are
// coarser than a tracked wrist. The on-screen paddle is enlarged to match —
// the VR paddles stay life-size, because in VR life-size is right.
export const DESKTOP_PADDLE_SCALE = 1.4;

const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _prevQuatInv = new THREE.Quaternion();
const _deltaQuat = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _arm = new THREE.Vector3();
const PADDLE_BOUNDS_COLOR = 0x35f2c1;

// A paddle attached to a WebXR controller grip. It tracks its own linear and
// angular velocity, which the physics step needs: the blade's speed sets how
// hard the ball comes off, and the speed of the surface across the ball — a
// product of the swing's rotation — is what puts spin on it.
export class Paddle {
  constructor() {
    this.mesh = buildPaddleMesh();

    this.velocity = new THREE.Vector3(); // linear, m/s
    this.angularVelocity = new THREE.Vector3(); // rad/s
    this.bladeCenter = new THREE.Vector3();
    this.bladeNormal = new THREE.Vector3();
    this.headRadius = PADDLE.HEAD_RADIUS;
    this.headThickness = PADDLE.HEAD_THICKNESS;
    this.bounds = new THREE.Box3();
    this.previousBounds = new THREE.Box3();
    this.boundsValid = false;
    this.previousBoundsValid = false;
    this.previousBladeCenter = new THREE.Vector3();
    this.sampledBladeCenter = new THREE.Vector3();
    this.sampledBladeCenterValid = false;
    this.boundsHelper = new THREE.Box3Helper(this.bounds, PADDLE_BOUNDS_COLOR);
    this.boundsHelper.visible = false;
    this.boundsHelper.renderOrder = 20;
    this.boundsHelper.material.depthTest = false;
    this.boundsHelper.material.transparent = true;
    this.boundsHelper.material.opacity = 0.85;
    this.boundsHelper.material.depthWrite = false;
    this.boundsHelper.frustumCulled = false;

    // False until two frames have been sampled — velocity is meaningless
    // before that, and a bogus first value can launch a ball across the room.
    this.tracking = false;

    // Whether this hand is actually holding the bat (see handedness setting).
    this.enabled = true;

    // Set on the rally opponent's bat so the game can tell whose hit it was.
    this.isOpponent = false;

    this._blade = this.mesh.getObjectByName('blade');
    this._profile = this._blade.getObjectByName('paddle-profile');
    this._gripTransform = {
      meshQuaternion: this.mesh.quaternion.clone(),
      bladePosition: this._blade.position.clone(),
      bladeQuaternion: this._blade.quaternion.clone(),
      profileQuaternion: this._profile.quaternion.clone(),
    };
    this._prevPos = new THREE.Vector3();
    this._prevQuat = new THREE.Quaternion();
    this._samples = 0;
    this._cameraSampleTime = null;
  }

  // Scales the whole bat, physics included — the head dimensions feed the
  // contact test, so a bigger paddle genuinely hits more balls.
  setScale(scale) {
    this.mesh.scale.setScalar(scale);
    this.headRadius = PADDLE.HEAD_RADIUS * scale;
    this.headThickness = PADDLE.HEAD_THICKNESS * scale;
  }

  attachTo(controllerGrip) {
    controllerGrip.add(this.mesh);
  }

  // A palm describes the striking face itself, rather than a controller grip.
  setPalmTrackingMode(active) {
    // Camera/hand input needs the same larger on-screen target as mouse play;
    // controller grips remain life-size unless this mode is explicitly active.
    this.setScale(active ? DESKTOP_PADDLE_SCALE : 1);
    if (active) {
      this.mesh.quaternion.identity();
      this._blade.position.set(0, 0, 0);
      this._blade.quaternion.identity();
      this._profile.quaternion.identity();
    } else {
      this.mesh.quaternion.copy(this._gripTransform.meshQuaternion);
      this._blade.position.copy(this._gripTransform.bladePosition);
      this._blade.quaternion.copy(this._gripTransform.bladeQuaternion);
      this._profile.quaternion.copy(this._gripTransform.profileQuaternion);
    }
    this.resetTracking();
  }

  resetTracking() {
    this._samples = 0;
    this._cameraSampleTime = null;
    this.tracking = false;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.boundsValid = false;
    this.previousBoundsValid = false;
    this.sampledBladeCenterValid = false;
    if (this.boundsHelper) {
      this.boundsHelper.visible = this.mesh.visible &&
        ((this.isOpponent && this.enabled) || this.networked);
    }
  }

  updateFromCamera(timestamp) {
    if (!Number.isFinite(timestamp) || (this._cameraSampleTime !== null && timestamp <= this._cameraSampleTime)) return;
    if (this._cameraSampleTime !== null && timestamp - this._cameraSampleTime > 250) this.resetTracking();
    const dt = this._cameraSampleTime === null ? 0 : (timestamp - this._cameraSampleTime) / 1000;
    this.update(dt);
    this._cameraSampleTime = timestamp;
  }

  // Call once per render frame with real elapsed time.
  update(dt) {
    this.mesh.updateWorldMatrix(true, true);
    this._blade.getWorldPosition(_worldPos);
    this._blade.getWorldQuaternion(_worldQuat);

    this.bladeCenter.copy(_worldPos);
    this.bladeNormal.set(0, 0, 1).applyQuaternion(_worldQuat);

    if (this._samples > 0 && dt > 1e-5) {
      this.velocity.copy(_worldPos).sub(this._prevPos).divideScalar(dt);

      // Hand tracking drops and recovers, and a single missed frame reads as
      // a huge jump in position — i.e. an enormous velocity that would fire
      // the ball across the room. Clamp to something well above a real
      // stroke so only glitches are rejected.
      const speed = this.velocity.length();
      if (speed > PADDLE.MAX_SWING_SPEED) {
        this.velocity.multiplyScalar(PADDLE.MAX_SWING_SPEED / speed);
      }

      // Angular velocity from the rotation between frames
      _prevQuatInv.copy(this._prevQuat).invert();
      _deltaQuat.copy(_worldQuat).multiply(_prevQuatInv).normalize();
      let angle = 2 * Math.acos(THREE.MathUtils.clamp(_deltaQuat.w, -1, 1));
      const s = Math.sqrt(Math.max(1 - _deltaQuat.w * _deltaQuat.w, 0));
      if (s < 1e-5) {
        this.angularVelocity.set(0, 0, 0);
      } else {
        if (angle > Math.PI) angle -= 2 * Math.PI; // shortest arc
        _axis.set(_deltaQuat.x / s, _deltaQuat.y / s, _deltaQuat.z / s);
        this.angularVelocity.copy(_axis).multiplyScalar(angle / dt);

        const rate = this.angularVelocity.length();
        if (rate > PADDLE.MAX_SWING_SPIN) {
          this.angularVelocity.multiplyScalar(PADDLE.MAX_SWING_SPIN / rate);
        }
      }

      this.tracking = true;
    }

    this.updateBounds();
    this._prevPos.copy(_worldPos);
    this._prevQuat.copy(_worldQuat);
    this._samples++;
  }

  // Live world-space AABB of the complete paddle, including the handle. The
  // helper is added to the scene by main.js because bounds are world-space.
  // This broad phase may admit extra candidates, but the swept face/radius
  // test in physics remains the actual contact rule. Every input source uses
  // this same transform-derived update path.
  updateBounds() {
    this.mesh.updateWorldMatrix(true, true);
    if (this.boundsValid) {
      this.previousBounds.copy(this.bounds);
      this.previousBoundsValid = true;
    }
    const hadPreviousSample = this.sampledBladeCenterValid;
    this.bounds.setFromObject(this.mesh);
    this._blade.getWorldPosition(_worldPos);
    this._blade.getWorldQuaternion(_worldQuat);
    this.previousBladeCenter.copy(hadPreviousSample ? this.sampledBladeCenter : _worldPos);
    this.bladeCenter.copy(_worldPos);
    this.sampledBladeCenter.copy(_worldPos);
    this.sampledBladeCenterValid = true;
    this.bladeNormal.set(0, 0, 1).applyQuaternion(_worldQuat).normalize();
    this.boundsValid = !this.bounds.isEmpty();
    this.boundsHelper.visible = this.mesh.visible &&
      (this.tracking || (this.isOpponent && this.enabled) || this.networked);
    if (this.boundsHelper.parent) {
      this.boundsHelper.updateWorldMatrix(true, true);
    }
    return this.bounds;
  }

  // Velocity of the blade surface at a world-space point.
  velocityAt(point, out) {
    _arm.copy(point).sub(this.bladeCenter);
    out.copy(this.angularVelocity).cross(_arm).add(this.velocity);
    return out;
  }
}

// Built the way a real bat is, which is what makes it read as one:
//
//   • one flat wood blank whose outline runs continuously from the blade,
//     through a narrow concave throat, down into a thin tang
//   • two shaped grip cheeks glued either side of that tang — that is what
//     gives the handle its thickness and its flare
//   • a rubber sheet on each face, stopping just short of the rim so a
//     sliver of ply shows all the way round
//
// The throat is the detail that matters most. A disc joined to a handle by a
// straight neck reads as a lollipop; the concave sweep from blade into
// handle is the shape the eye actually recognises as a bat.
//
// Dimensions are a real bat's: a 150 x 158 mm blade, 100 mm handle, roughly
// 260 mm overall.

const BLADE_RX = 0.075; // blade half-width
const BLADE_RY = 0.079; // half-height; blades are slightly taller than wide
const PLY_THICKNESS = 0.0062;
const RUBBER_THICKNESS = 0.0019;
const THROAT_HALF = 0.019; // half-width where the blade necks down
const TANG_HALF = 0.0125;
const HANDLE_TOP = -0.098;
const HANDLE_LEN = 0.1;
const HANDLE_END = HANDLE_TOP - HANDLE_LEN;

function buildPaddleMesh() {
  const group = new THREE.Group();

  const ply = new THREE.MeshStandardMaterial({
    color: 0xbf9560,
    roughness: 0.62,
    metalness: 0,
  });
  const gripWood = new THREE.MeshStandardMaterial({
    color: 0x7d3b2a,
    roughness: 0.72,
    metalness: 0,
  });
  const rubberRed = new THREE.MeshStandardMaterial({
    map: rubberTexture('#b62a20'),
    color: 0xffffff,
    roughness: 0.98,
    metalness: 0,
  });
  const rubberBlack = new THREE.MeshStandardMaterial({
    map: rubberTexture('#161618'),
    color: 0xffffff,
    roughness: 0.98,
    metalness: 0,
  });

  const blade = new THREE.Group();
  blade.name = 'blade';

  // Everything is modelled in profile space (handle down −Y) inside this
  // group, which is turned once at the end. Turning each piece individually
  // would compose with the mirroring rotations on the back-facing pieces and
  // throw them onto the wrong axis.
  const art = new THREE.Group();
  art.name = 'paddle-profile';
  blade.add(art);

  // --- The wood blank: blade + throat + tang, one continuous outline ------
  const blank = extrude(blankProfile(), PLY_THICKNESS);
  const core = new THREE.Mesh(blank, ply);
  core.castShadow = true;
  art.add(core);

  // --- Rubber on both faces ------------------------------------------------
  const sheet = extrude(rubberProfile(), RUBBER_THICKNESS, 0.0005);
  for (const [material, side] of [
    [rubberRed, 1],
    [rubberBlack, -1],
  ]) {
    const face = new THREE.Mesh(sheet, material);
    face.position.z = side * (PLY_THICKNESS / 2);
    if (side < 0) face.rotation.y = Math.PI; // the extrusion grows along +Z
    art.add(face);
  }

  // --- Grip cheeks, one glued to each side of the tang --------------------
  const cheek = extrude(cheekProfile(), 0.0088, 0.0032);
  for (const side of [1, -1]) {
    const mesh = new THREE.Mesh(cheek, gripWood);
    mesh.position.z = side * (PLY_THICKNESS / 2);
    if (side < 0) mesh.rotation.y = Math.PI;
    mesh.castShadow = true;
    art.add(mesh);
  }

  // The profile is drawn with the handle running down −Y. Turn it so the
  // handle runs along −X, which becomes "back toward the hand" once the
  // blade is rotated to face sideways. Rotating about the face axis leaves
  // the physics normal (+Z) untouched.
  art.rotation.z = -Math.PI / 2;

  // Blade group origin is the head centre, which is also the contact disc
  // the physics uses, so the whole bat hangs off that point.
  blade.position.set(0, 0.016, -(PADDLE.HANDLE_LENGTH * 0.5 + BLADE_RX * 0.6));
  blade.rotation.y = Math.PI / 2;
  group.add(blade);

  return group;
}

function extrude(shape, depth, bevel = 0.0009) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 40,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

// Blade ellipse, swept anticlockwise, then a concave throat down into the
// tang and back up the other side. Drawn with absellipse at real radii —
// scaling a unit circle afterwards leaves the straight segments and the arc
// in different units, which is exactly how this went wrong the first time.
function blankProfile() {
  const s = new THREE.Shape();
  // Parametric angle at which the rim reaches the throat's half-width
  const a = Math.acos(THROAT_HALF / BLADE_RX);
  const y0 = -BLADE_RY * Math.sin(a);

  s.moveTo(THROAT_HALF, y0);
  s.absellipse(0, 0, BLADE_RX, BLADE_RY, -a, Math.PI + a, false, 0);

  // Concave sweep into the tang — the shape that says "bat" rather than
  // "lollipop". Control points pull inward, not outward.
  s.bezierCurveTo(-0.017, y0 - 0.012, -TANG_HALF, y0 - 0.016, -TANG_HALF, HANDLE_TOP);
  s.lineTo(-TANG_HALF, HANDLE_END + 0.004);
  s.quadraticCurveTo(-TANG_HALF, HANDLE_END, -TANG_HALF + 0.004, HANDLE_END);
  s.lineTo(TANG_HALF - 0.004, HANDLE_END);
  s.quadraticCurveTo(TANG_HALF, HANDLE_END, TANG_HALF, HANDLE_END + 0.004);
  s.lineTo(TANG_HALF, HANDLE_TOP);
  s.bezierCurveTo(TANG_HALF, y0 - 0.016, 0.017, y0 - 0.012, THROAT_HALF, y0);
  s.closePath();
  return s;
}

// The rubber covers the blade face but stops short of the rim.
function rubberProfile() {
  const inset = 0.0024; // a thin sliver of ply, not a wide border
  const s = new THREE.Shape();
  s.absellipse(0, 0, BLADE_RX - inset, BLADE_RY - inset, 0, Math.PI * 2, false, 0);
  return s;
}

// A grip cheek: waisted where the fingers sit, flared at the butt so the
// hand cannot slide off.
function cheekProfile() {
  // The cheek runs up into the throat and dies away to nothing there, rather
  // than stopping at a flat edge. A squared-off top reads as a separate
  // block bolted to the blade; a real grip tapers out of the throat.
  const tip = HANDLE_TOP + 0.026; // how far up the throat the cheek reaches
  const wTip = 0.0092;
  const shoulder = HANDLE_TOP - 0.004;
  const wShoulder = 0.0158;
  const wWaist = 0.0133;
  const wEnd = 0.0228;
  const end = HANDLE_END;

  const s = new THREE.Shape();
  s.moveTo(wTip, tip);
  s.bezierCurveTo(wShoulder, tip - 0.012, wShoulder, shoulder, wShoulder, shoulder);
  s.bezierCurveTo(wWaist, shoulder - 0.035, wWaist, end + 0.032, wEnd, end + 0.009);
  s.quadraticCurveTo(wEnd, end, wEnd - 0.008, end);
  s.lineTo(-(wEnd - 0.008), end);
  s.quadraticCurveTo(-wEnd, end, -wEnd, end + 0.009);
  s.bezierCurveTo(-wWaist, end + 0.032, -wWaist, shoulder - 0.035, -wShoulder, shoulder);
  s.bezierCurveTo(-wShoulder, shoulder, -wShoulder, tip - 0.012, -wTip, tip);
  s.quadraticCurveTo(0, tip + 0.009, wTip, tip); // rounded crown
  s.closePath();
  return s;
}

// Matte rubber with a fine pimple pattern. Without it the face is a flat
// disc of colour and reads as plastic; the texture is what sells it as
// rubber at arm's length.
let rubberTextures = null;
function rubberTexture(hex) {
  rubberTextures ??= new Map();
  if (rubberTextures.has(hex)) return rubberTextures.get(hex);

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, size, size);

  // Staggered dimples, lit from the top-left so they read as texture
  const pitch = 7;
  for (let y = 0, row = 0; y < size; y += pitch, row++) {
    for (let x = (row % 2) * (pitch / 2); x < size; x += pitch) {
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(x, y, 2, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(x + 1, y + 1, 2, 2);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(9, 9);
  tex.anisotropy = 8;
  rubberTextures.set(hex, tex);
  return tex;
}
