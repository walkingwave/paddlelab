import * as THREE from 'three';
import { PLAY_AREA, TABLE } from './constants.js';

export const HELD_SERVE_HEIGHT = TABLE.HEIGHT + 0.19;
export const HELD_SERVE_DEPTH = 0.72;

// Park a practice/rally serve at the desktop bat's normal contact point. The
// old spot was 23 cm above and 10 cm beyond the default blade pose, making a
// supposedly held serve physically unreachable without first finding it.
export function createHeldServePosition({ side = 1, x = 0 } = {}) {
  return new THREE.Vector3(
    x,
    HELD_SERVE_HEIGHT,
    side * (PLAY_AREA.PLAYER_Z - HELD_SERVE_DEPTH)
  );
}

export const HELD_SERVE_BOB = 0.035;
export const HELD_SERVE_BOB_SPEED = 2.2;

// A physical serve: the ball starts just beyond the blade and drifts back
// through its face. That gives the player a visible toss while their forward
// stroke and the ball meet head-on, instead of the bat overtaking a ball that
// is already travelling toward the net.
export const SERVE_TOSS_UP = 1.5;
export const SERVE_TOSS_BACK_SPEED = 0.4;
export const SERVE_TOSS_DISTANCE = 0.13;
export const SERVE_TOSS_HEIGHT = 0.025;

export function createServeToss({ center, toNet, normal = null }) {
  const direction = new THREE.Vector3(0, 0, toNet < 0 ? -1 : 1);
  const faceNormal = normal?.isVector3
    ? normal.clone()
    : normal
      ? new THREE.Vector3(normal.x ?? 0, normal.y ?? 0, normal.z ?? 0)
      : direction.clone();
  if (faceNormal.lengthSq() < 1e-8) faceNormal.copy(direction);
  faceNormal.normalize();
  // Paddle faces are two-sided; put the ball on the net-facing side regardless
  // of how the wrist/controller happens to orient the normal.
  if (faceNormal.dot(direction) < 0) faceNormal.negate();

  const position = new THREE.Vector3().copy(center);
  position.addScaledVector(faceNormal, SERVE_TOSS_DISTANCE);
  position.y += SERVE_TOSS_HEIGHT;

  const backSpeed = SERVE_TOSS_BACK_SPEED + Math.max(0, SERVE_TOSS_UP * faceNormal.y);
  const velocity = new THREE.Vector3(0, SERVE_TOSS_UP, 0);
  velocity.addScaledVector(faceNormal, -backSpeed);
  return { position, velocity };
}
