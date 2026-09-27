import * as THREE from 'three';
import { TABLE, NET, BALL, PADDLE, PHYSICS } from './constants.js';

// Custom fixed-timestep physics for a single spinning sphere against a few
// analytic surfaces. A full rigid-body engine would be overkill here: the
// only interesting contact is ball-against-plane, and doing it by hand keeps
// spin behaviour tunable, which is the whole point of a trainer.
//
// Spin model
// ----------
// Every contact resolves a normal impulse and a Coulomb-limited tangential
// impulse. The tangential part is what couples spin and velocity: it's why a
// topspin ball kicks forward off the bounce, why backspin checks up, and why
// brushing the paddle up the back of the ball loads topspin onto it.
//
// For a solid sphere (I = 2/5 mR²) the tangential impulse needed to bring the
// contact patch to rest — i.e. to start rolling — is (2/7)m|u|, where u is the
// contact-point velocity. Friction caps the impulse at μ·jₙ, so a glancing
// contact slides and a grippy one grabs. Mass cancels throughout, so the code
// works in impulse-per-unit-mass.

const _rel = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _vt = new THREE.Vector3();
const _u = new THREE.Vector3();
const _uHat = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _surfaceVel = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _paddlePreviousCenter = new THREE.Vector3();
const _paddleContactCenter = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _ballBounds = new THREE.Box3();
const _previousBallBounds = new THREE.Box3();
const _sweptBounds = new THREE.Box3();
const _sweptPaddleBounds = new THREE.Box3();

// Restitution curves per surface. See BALL in constants.js for why COR has to
// vary with impact speed rather than being a single number.
const TABLE_COR = {
  base: BALL.RESTITUTION_TABLE,
  min: BALL.RESTITUTION_TABLE_MIN,
  ref: BALL.RESTITUTION_TABLE_REF,
};
const PADDLE_COR = {
  base: BALL.RESTITUTION_PADDLE,
  min: BALL.RESTITUTION_PADDLE_MIN,
  ref: BALL.RESTITUTION_PADDLE_REF,
};
const FLOOR_COR = { base: BALL.RESTITUTION_FLOOR, min: 0.3, ref: 6 };

function restitutionAt(curve, impact) {
  const t = impact / curve.ref;
  return curve.min + (curve.base - curve.min) / (1 + t * t);
}

export class PhysicsWorld {
  constructor() {
    this._accumulator = 0;
    // Callbacks the game layer can hook: (ball, eventName)
    this.onBounce = null; // 'table' | 'floor' | 'net' | 'paddle' | 'edge'
  }

  // dt = real frame time; steps physics at FIXED_DT.
  step(dt, balls, paddles) {
    // Paddle.update() samples each input pose before physics. Preserve its last
    // sampled bounds here; refreshing every paddle again would overwrite the
    // previous box and defeat the swept paddle broad phase below.
    for (const paddle of paddles) {
      if (!paddle.boundsValid) paddle.updateBounds?.();
    }
    this._accumulator += Math.min(dt, 0.1); // clamp to avoid spiral after a pause
    while (this._accumulator >= PHYSICS.FIXED_DT) {
      for (const ball of balls) {
        if (ball.active) this._integrate(ball, paddles, PHYSICS.FIXED_DT);
      }
      this._accumulator -= PHYSICS.FIXED_DT;
    }
  }

  _integrate(ball, paddles, h) {
    const p = ball.mesh.position;
    const v = ball.velocity;

    _prev.copy(p);

    // A frozen ball hangs where it was put: no gravity, no drag, no bounce.
    // It is still collidable, because the whole point is to hit it — the
    // strike is what releases it.
    if (ball.frozen) {
      for (const paddle of paddles) this._collidePaddle(ball, paddle, _prev);
      return;
    }

    // --- Aerodynamics -----------------------------------------------------
    const speed = v.length();
    _accel.set(0, PHYSICS.GRAVITY, 0);

    if (speed > 1e-4) {
      // Quadratic drag: a = -k|v|v. A ping pong ball is extremely light for
      // its frontal area, so drag is not a rounding error — it takes several
      // m/s off a hard hit across the length of the table.
      _accel.addScaledVector(v, -PHYSICS.DRAG * speed);

      // Magnus: a = C(ω × v). Topspin (ω pointing along −X for a ball
      // travelling +Z) curves the flight downward; backspin floats it.
      if (ball.spin.lengthSq() > 1e-6) {
        _tmp.copy(ball.spin).cross(v).multiplyScalar(PHYSICS.MAGNUS);
        _accel.add(_tmp);
      }
    }

    v.addScaledVector(_accel, h);
    p.addScaledVector(v, h);

    // Spin bleeds off slowly in flight
    if (ball.spin.lengthSq() > 1e-6) {
      ball.spin.multiplyScalar(Math.pow(BALL.SPIN_DECAY, h));
    }

    // --- Contacts ---------------------------------------------------------
    this._collideNet(ball, _prev);
    this._collideTable(ball);
    this._collideFloor(ball);

    for (const paddle of paddles) {
      this._collidePaddle(ball, paddle, _prev);
    }
  }

  _collideTable(ball) {
    const p = ball.mesh.position;
    const v = ball.velocity;
    const surfaceY = TABLE.HEIGHT + BALL.RADIUS;

    const onTable =
      Math.abs(p.x) <= TABLE.WIDTH / 2 && Math.abs(p.z) <= TABLE.LENGTH / 2;
    if (!onTable || p.y >= surfaceY || v.y >= 0) return;

    p.y = surfaceY;
    if (this._resolveContact(ball, _up, TABLE_COR, BALL.FRICTION_TABLE, null, 'table')) {
      this.onBounce?.(ball, 'table');
    }
  }

  _collideFloor(ball) {
    const p = ball.mesh.position;
    const v = ball.velocity;
    if (p.y >= BALL.RADIUS || v.y >= 0) return;

    p.y = BALL.RADIUS;
    if (this._resolveContact(ball, _up, FLOOR_COR, 0.5, null, 'floor')) {
      this.onBounce?.(ball, 'floor');
    }
  }

  // The net is only a couple of millimetres thick, and a hard drive covers
  // several centimetres per step, so a position test alone would let the ball
  // teleport straight through it. Test the z = 0 crossing over the step
  // instead.
  _collideNet(ball, prev) {
    const p = ball.mesh.position;
    const v = ball.velocity;

    const crossed = (prev.z < 0 && p.z >= 0) || (prev.z > 0 && p.z <= 0);
    if (!crossed) return;

    // Interpolate the crossing point to see whether it actually met the net
    const t = Math.abs(prev.z) / Math.max(Math.abs(prev.z - p.z), 1e-6);
    const x = prev.x + (p.x - prev.x) * t;
    const y = prev.y + (p.y - prev.y) * t;

    const halfSpan = TABLE.WIDTH / 2 + NET.OVERHANG;
    const top = TABLE.HEIGHT + NET.HEIGHT;
    if (Math.abs(x) > halfSpan || y > top + BALL.RADIUS || y < TABLE.HEIGHT) {
      return;
    }

    const clipsTape = y > top - BALL.RADIUS;
    const side = Math.sign(prev.z) || 1;

    if (clipsTape) {
      // Caught the tape: most of the pace is gone and the ball topples over
      // more or less vertically — the classic net cord dribble.
      v.z *= 0.18;
      v.x *= 0.4;
      v.y = Math.min(v.y, 0.6);
      p.z = -side * BALL.RADIUS * 0.5; // trickles over onto the far side
    } else {
      // Into the net proper: it absorbs nearly everything and drops the ball.
      v.z *= -0.12;
      v.x *= 0.35;
      v.y *= 0.3;
      p.z = side * (BALL.RADIUS + 0.002);
    }

    ball.spin.multiplyScalar(0.25);
    this.onBounce?.(ball, 'net');
  }

  // Resolves one contact against a plane with normal `n`.
  //
  // `surfaceVel` is the velocity of the surface at the contact point (null
  // for static geometry). Returns true for a genuine bounce, false when the
  // ball is merely resting — a naive `v.y = -v.y·e` never reaches zero, so
  // gravity would push a settled ball back through the surface every step and
  // fire contacts at the full simulation rate.
  _resolveContact(ball, n, curve, friction, surfaceVel, surface) {
    const v = ball.velocity;

    // Velocity relative to the surface
    _tmp.copy(v);
    if (surfaceVel) _tmp.sub(surfaceVel);

    const vn = _tmp.dot(n);
    if (vn >= 0) return false;

    const impact = -vn;
    const restitution = restitutionAt(curve, impact);
    const resting = impact < PHYSICS.REST_SPEED && !surfaceVel;

    // Tangential part of the relative velocity
    _vt.copy(_tmp).addScaledVector(n, -vn);

    // Contact-point velocity: tangential slip plus the surface speed the
    // ball's own rotation contributes at the contact patch (r = −R·n).
    _u.copy(_vt);
    _tmp.copy(ball.spin).cross(n).multiplyScalar(-BALL.RADIUS);
    _u.add(_tmp);

    const slip = _u.length();
    if (slip > 1e-5) {
      _uHat.copy(_u).divideScalar(slip);

      // Impulse per unit mass. Capped by Coulomb friction, and never more
      // than what it takes to stop the contact patch sliding (2/7)|u|.
      const normalImpulse = (1 + restitution) * impact;
      const jt = Math.min(friction * normalImpulse, (2 / 7) * slip);

      v.addScaledVector(_uHat, -jt);

      // Δω = (5·jt / 2R)(n × û)
      _tmp.copy(n).cross(_uHat).multiplyScalar((5 * jt) / (2 * BALL.RADIUS));
      ball.spin.add(_tmp);

      const spinRate = ball.spin.length();
      if (spinRate > BALL.MAX_SPIN) {
        ball.spin.multiplyScalar(BALL.MAX_SPIN / spinRate);
      }
    }

    // Normal response
    const vnNow = v.dot(n) - (surfaceVel ? surfaceVel.dot(n) : 0);
    if (resting) {
      v.addScaledVector(n, -vnNow); // kill the normal component entirely
      ball.restingOn = surface;
      return false;
    }

    v.addScaledVector(n, -(1 + restitution) * vnNow);
    ball.restingOn = null;
    return true;
  }

  // Swept paddle contact. The blade is ~15 mm thick and a returned ball can
  // travel 5 cm in a single step, so testing only the end-of-step position
  // would let fast balls pass straight through the bat — which in a trainer
  // reads as "my hit didn't register".
  _collidePaddle(ball, paddle, prev) {
    // An AI paddle is authored by the game loop rather than by a controller
    // or camera. It can be on its first sampled frame and therefore has no
    // meaningful `tracking` history yet; blocking that frame makes a valid
    // prepared return disappear at startup. Human inputs still require two
    // samples so a camera/controller reconnect cannot create a fake swing.
    if ((!paddle.tracking && !paddle.isOpponent) || !paddle.enabled) return;

    const p = ball.mesh.position;
    if (paddle.boundsValid) {
      _ballBounds.setFromCenterAndSize(p, _tmp.setScalar(BALL.RADIUS * 2));
      _previousBallBounds.setFromCenterAndSize(prev, _tmp.setScalar(BALL.RADIUS * 2));
      const currentBounds = paddle.bounds;
      const previousBounds = paddle.previousBoundsValid
        ? paddle.previousBounds
        : currentBounds;
      _sweptBounds.copy(_ballBounds).union(_previousBallBounds);
      _sweptPaddleBounds.copy(currentBounds).union(previousBounds);
      if (!_sweptPaddleBounds.intersectsBox(_sweptBounds)) return;
    }
    _n.copy(paddle.bladeNormal);
    _paddlePreviousCenter.copy(paddle.previousBoundsValid
      ? paddle.previousBladeCenter ?? paddle.bladeCenter
      : paddle.bladeCenter);

    const halfThick = (paddle.headThickness ?? PADDLE.HEAD_THICKNESS) / 2 + BALL.RADIUS;

    // Test the ball path relative to the paddle's previous and current face
    // centres. The paddle can move substantially between render samples; a
    // stationary final-plane test would lose contact even when its live box
    // swept directly through the ball.
    _rel.copy(prev).sub(_paddlePreviousCenter);
    const d0 = _rel.dot(_n);
    _rel.copy(p).sub(paddle.bladeCenter);
    const d1 = _rel.dot(_n);

    // Either the ball ends the step inside the blade slab, or it passed
    // clean through it during the step.
    const inside = Math.abs(d1) <= halfThick;
    const swept = d0 > halfThick !== d1 > halfThick || d0 < -halfThick !== d1 < -halfThick;
    if (!inside && !swept) return;

    // Contact point: where the path met the blade plane
    const denom = d0 - d1;
    const t = Math.abs(denom) < 1e-9 ? 0 : d0 / denom;
    const contactTime = THREE.MathUtils.clamp(t, 0, 1);
    _hit.copy(prev).lerp(p, contactTime);
    _paddleContactCenter.copy(_paddlePreviousCenter).lerp(paddle.bladeCenter, contactTime);

    // Radial distance from the blade axis at that point
    _rel.copy(_hit).sub(_paddleContactCenter);
    _tmp.copy(_rel).addScaledVector(_n, -_rel.dot(_n));
    const radius = paddle.headRadius ?? PADDLE.HEAD_RADIUS;
    if (_tmp.length() > radius) return;

    // Face the normal toward the side the ball came from
    if (d0 < 0) _n.negate();

    // Surface velocity at the contact point, including the swing's rotation —
    // brushing across the ball is what actually generates spin.
    paddle.velocityAt(_hit, _surfaceVel);
    _tmp.copy(ball.velocity).sub(_surfaceVel);
    if (_tmp.dot(_n) >= 0) return; // moving away; already handled

    // Place the ball on the struck face before resolving
    p.copy(_hit).addScaledVector(_n, halfThick * 1.02);
    paddle.velocityAt(_hit, _surfaceVel);

    this._resolveContact(
      ball,
      _n,
      PADDLE_COR,
      BALL.FRICTION_PADDLE,
      _surfaceVel,
      null
    );

    // Struck: a held ball is released by the hit and flies from here.
    ball.frozen = false;
    ball.serveToss = null;
    ball.touchedByPaddle = true;
    ball.lastHitBy = paddle;
    ball.retireIn = null;
    // Pass the bat along: the game has to tell your hits from the
    // opponent's, and they arrive through the same contact path.
    this.onBounce?.(ball, 'paddle', paddle);
  }
}
