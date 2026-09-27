import * as THREE from 'three';
import { BALL } from './constants.js';
import { ballTexture } from './textures.js';
import { HELD_SERVE_BOB, HELD_SERVE_BOB_SPEED } from './serve.js';

// Geometry and material are built once and shared across the whole pool.
let sharedGeometry = null;
let sharedMaterial = null;

function shared() {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.SphereGeometry(BALL.RADIUS, 24, 16);
    sharedMaterial = new THREE.MeshStandardMaterial({
      map: ballTexture(),
      roughness: 0.45,
      metalness: 0.0,
    });
  }
  return { geometry: sharedGeometry, material: sharedMaterial };
}

const _axis = new THREE.Vector3();
const _spinStep = new THREE.Quaternion();

export class Ball {
  constructor() {
    const { geometry, material } = shared();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;

    this.velocity = new THREE.Vector3();
    this.spin = new THREE.Vector3(); // angular velocity, rad/s
    this.active = false; // inactive balls are hidden and skip physics
    this.mesh.visible = false;
    this.restingOn = null; // 'table' | 'floor' once the ball has settled
    this.retireIn = null; // seconds until this ball returns to the pool
    this.touchedByPaddle = false; // did the player actually hit this one?
    this.isFeed = false; // tossed up for the player rather than launched at them

    // Held still in mid-air, waiting to be struck. Coach uses this to park
    // the ball exactly where the stroke should meet it, which removes the
    // question of timing a moving feed to a swing entirely.
    this.frozen = false;
    this.serveToss = null;
    this.awaitingServeStrike = false;
    this.floorCounted = false;

    // Scoring bookkeeping, owned here so that serving a ball is the single
    // point where a ball's life resets. Hanging these off the retire path
    // instead would mean any other route back into the pool leaves a ball
    // permanently unable to score.
    this.scoredTarget = false;
    this.awaitingOutcome = false; // struck, but not yet landed anywhere
    this.countedHit = false;
    this.countedReturn = false;
    this.countedMiss = false;
    this.tournamentPointCounted = false;
  }

  serve(position, velocity, spin) {
    this.mesh.position.copy(position);
    this.velocity.copy(velocity);
    this.spin.copy(spin ?? _axis.set(0, 0, 0));
    this.mesh.quaternion.identity();
    this.active = true;
    this.mesh.visible = true;
    this.restingOn = null;
    this.retireIn = null;
    this.touchedByPaddle = false;
    this.isFeed = false;
    this.frozen = false;
    this.serveToss = null;
    this.awaitingServeStrike = false;
    this.floorCounted = false;
    this.scoredTarget = false;
    this.awaitingOutcome = false; // struck, but not yet landed anywhere
    this.countedHit = false;
    this.countedReturn = false;
    this.countedMiss = false;
    this.tournamentPointCounted = false;
  }

  deactivate() {
    this.active = false;
    this.mesh.visible = false;
    this.serveToss = null;
    this.awaitingServeStrike = false;
    this.floorCounted = false;
  }

  // A serve waits for a real stroke rather than falling away under gravity.
  // It bobs vertically at a fixed x/z point, giving every input method the
  // same clear, repeatable ball to hit.
  holdForServe(position, { amplitude = HELD_SERVE_BOB, angularSpeed = HELD_SERVE_BOB_SPEED } = {}) {
    this.serve(position, _axis.set(0, 0, 0));
    this.frozen = true;
    this.mesh.position.y = position.y + amplitude;
    this.serveToss = {
      centerY: position.y,
      amplitude,
      angularSpeed,
      phase: Math.PI / 2,
    };
  }

  updateServeToss(dt) {
    if (!this.serveToss || !this.frozen) return;
    const toss = this.serveToss;
    toss.phase += toss.angularSpeed * dt;
    this.mesh.position.y = toss.centerY + toss.amplitude * Math.sin(toss.phase);
  }

  // Spins the mesh so the painted seam and logo actually rotate. Without this
  // the ball's spin state — the thing the trainer is teaching you to read —
  // would be completely invisible.
  updateVisualSpin(dt) {
    const rate = this.spin.length();
    if (rate < 1e-3) return;
    _axis.copy(this.spin).divideScalar(rate);
    _spinStep.setFromAxisAngle(_axis, rate * dt);
    this.mesh.quaternion.premultiply(_spinStep);
  }
}
