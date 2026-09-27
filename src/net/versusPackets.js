import * as THREE from 'three';

// Five tries at 0.6s, 1.2s, 2.4s, 4s, 4s covers a Wi-Fi blip, a laptop display
// sleep, or a relay restart. Past that the player is told plainly rather than
// left watching a countdown that will never finish.
export const VERSUS_RECONNECT_LIMIT = 5;

// Exponential backoff capped at 4s, so a one-frame drop is invisible but a
// dead relay is not hammered.
export function versusReconnectDelay(attempt) {
  return Math.min(600 * 2 ** (attempt - 1), 4000);
}

// The remote bat is posed entirely by these packets, so they stay deliberately
// small: two vectors, a velocity, and one flag.
export function encodeBladePacket(paddle) {
  return {
    c: [paddle.bladeCenter.x, paddle.bladeCenter.y, paddle.bladeCenter.z],
    n: [paddle.bladeNormal.x, paddle.bladeNormal.y, paddle.bladeNormal.z],
    v: [paddle.velocity.x, paddle.velocity.y, paddle.velocity.z],
    // Whether the sender's bat is actually being tracked. Someone watching
    // from a desktop browser has a paddle object but no pose for it, and
    // without this flag it would arrive as a phantom bat parked at the origin
    // — which is on the table, swatting balls its owner can't see.
    t: paddle.tracking,
  };
}

const _forward = new THREE.Vector3(0, 0, 1);
const _quat = new THREE.Quaternion();
const _meshLocalQuat = new THREE.Quaternion();
const _bladeLocalNormal = new THREE.Vector3();
const _parentLocalNormal = new THREE.Vector3();
const _meshOffset = new THREE.Vector3();
const _meshWorldPosition = new THREE.Vector3();
const _parentWorld = new THREE.Matrix4();
const _parentInverse = new THREE.Matrix4();
const _parentLinear = new THREE.Matrix3();
const _parentTranspose = new THREE.Matrix3();

// Write a received blade packet onto a paddle object. Returns false when the
// packet is missing or its owner is not tracking, so callers can treat those
// cases as "no pose" without repeating the checks.
export function applyRemotePaddle(paddle, pkt) {
  if (
    !pkt ||
    !Array.isArray(pkt.c) || pkt.c.length !== 3 || !pkt.c.every(Number.isFinite) ||
    !Array.isArray(pkt.n) || pkt.n.length !== 3 || !pkt.n.every(Number.isFinite) ||
    !Array.isArray(pkt.v) || pkt.v.length !== 3 || !pkt.v.every(Number.isFinite) ||
    Math.hypot(...pkt.n) < 1e-8
  ) return false;
  const tracked = pkt.t !== false;
  paddle.enabled = tracked;
  // This paddle never runs Paddle.update(), so mark it tracked here —
  // otherwise the swept contact test skips it and the opponent could never
  // return a ball.
  paddle.tracking = tracked;
  if (!tracked) {
    paddle.mesh.visible = false;
    if (paddle.boundsHelper) paddle.boundsHelper.visible = false;
    return false;
  }
  paddle.bladeCenter.set(pkt.c[0], pkt.c[1], pkt.c[2]);
  paddle.bladeNormal.set(pkt.n[0], pkt.n[1], pkt.n[2]).normalize();
  paddle.velocity.set(pkt.v[0], pkt.v[1], pkt.v[2]);
  paddle.mesh.visible = true;
  const blade = paddle.mesh.getObjectByName?.('blade');
  if (blade) {
    // Packets use world-space blade centre and normal. Pull the desired world
    // normal into parent space with the transpose of its linear transform;
    // this handles rotated and non-uniformly scaled rigs correctly.
    paddle.mesh.updateWorldMatrix?.(true, false);
    if (paddle.mesh.parent) {
      paddle.mesh.parent.updateWorldMatrix(true, false);
      _parentWorld.copy(paddle.mesh.parent.matrixWorld);
      _parentInverse.copy(_parentWorld).invert();
      _parentLinear.setFromMatrix4(_parentWorld);
      _parentTranspose.copy(_parentLinear).transpose();
      _parentLocalNormal.copy(paddle.bladeNormal).applyMatrix3(_parentTranspose).normalize();
    } else {
      _parentWorld.identity();
      _parentInverse.identity();
      _parentLinear.identity();
      _parentLocalNormal.copy(paddle.bladeNormal);
    }
    _bladeLocalNormal.copy(_forward).applyQuaternion(blade.quaternion).normalize();
    _meshLocalQuat.setFromUnitVectors(_bladeLocalNormal, _parentLocalNormal);
    paddle.mesh.quaternion.copy(_meshLocalQuat);

    // Include parent rotation/scale when locating the blade offset. Applying
    // the full inverse parent matrix to the desired world origin yields the
    // correct local position even for a translated/rotated/scaled parent.
    _meshOffset.copy(blade.position).multiply(paddle.mesh.scale).applyQuaternion(_meshLocalQuat);
    _meshOffset.applyMatrix3(_parentLinear);
    _meshWorldPosition.copy(paddle.bladeCenter).sub(_meshOffset);
    paddle.mesh.position.copy(_meshWorldPosition.applyMatrix4(_parentInverse));
  } else {
    paddle.mesh.position.copy(paddle.bladeCenter);
    paddle.mesh.quaternion.copy(
      _quat.setFromUnitVectors(_forward, paddle.bladeNormal)
    );
  }
  paddle.mesh.updateWorldMatrix?.(true, true);
  paddle.updateBounds?.();
  if (paddle.boundsHelper) paddle.boundsHelper.visible = true;
  return true;
}
