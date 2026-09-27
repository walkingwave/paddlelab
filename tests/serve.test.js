import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  HELD_SERVE_BOB,
  HELD_SERVE_BOB_SPEED,
  HELD_SERVE_DEPTH,
  HELD_SERVE_HEIGHT,
  SERVE_TOSS_DISTANCE,
  SERVE_TOSS_BACK_SPEED,
  SERVE_TOSS_HEIGHT,
  SERVE_TOSS_UP,
  createHeldServePosition,
  createServeToss,
} from '../src/serve.js';
import { BALL, PLAY_AREA, TABLE } from '../src/constants.js';
import { Ball } from '../src/ball.js';
import { PhysicsWorld } from '../src/physics.js';

test('serve toss crosses the net-facing side of either bat regardless of its orientation', () => {
  for (const toNet of [-1, 1]) {
    for (const normal of [
      new THREE.Vector3(0, 0, toNet),
      new THREE.Vector3(0, 0, -toNet),
      new THREE.Vector3(0.2, 0.4, toNet).normalize(),
    ]) {
      const center = new THREE.Vector3(0.12, 0.94, toNet < 0 ? 1.05 : -1.05);
      const { position, velocity } = createServeToss({ center, toNet, normal });
      const direction = new THREE.Vector3(0, 0, toNet);
      const faceNormal = normal.clone();
      if (faceNormal.dot(direction) < 0) faceNormal.negate();

      const tossOffset = position.clone().sub(center);
      assert.ok(Math.abs(tossOffset.y - SERVE_TOSS_HEIGHT - SERVE_TOSS_DISTANCE * faceNormal.y) < 1e-9);
      tossOffset.y -= SERVE_TOSS_HEIGHT;
      assert.ok(Math.abs(tossOffset.dot(faceNormal) - SERVE_TOSS_DISTANCE) < 1e-9);
      assert.ok(position.clone().sub(center).dot(faceNormal) > 0, 'the toss starts on the net-facing side');
      assert.ok(velocity.dot(faceNormal) < 0, 'the ball drifts back across the blade toward the server');
      const backSpeed = SERVE_TOSS_BACK_SPEED + Math.max(0, SERVE_TOSS_UP * faceNormal.y);
      assert.ok(Math.abs(velocity.y - (SERVE_TOSS_UP - backSpeed * faceNormal.y)) < 1e-9);
    }
  }
});

test('serve toss crosses the paddle plane during a readable low arc', () => {
  const center = new THREE.Vector3(0, 0.94, 1.05);
  const { position, velocity } = createServeToss({ center, toNet: -1 });
  const distance = SERVE_TOSS_DISTANCE;
  const crossingTime = distance / SERVE_TOSS_BACK_SPEED;
  const crossingY = position.y + velocity.y * crossingTime - 0.5 * 9.81 * crossingTime ** 2;

  assert.ok(crossingTime > 0.25 && crossingTime < 0.4);
  assert.ok(crossingY > center.y - 0.12 && crossingY < center.y + 0.12);
  assert.ok(velocity.z > 0, 'the host-side ball is moving toward the server when it reaches the blade');
});

test('the serve toss is physically hittable from the paddle stance on either side', () => {
  for (const toNet of [-1, 1]) {
    const center = createHeldServePosition({ side: toNet < 0 ? 1 : -1 });
    const { position, velocity } = createServeToss({ center, toNet, normal: new THREE.Vector3(0, 0, -toNet) });
    const paddle = {
      bladeCenter: center.clone(),
      bladeNormal: new THREE.Vector3(0, 0, toNet),
      headRadius: 0.077,
      headThickness: 0.015,
      boundsValid: true,
      bounds: new THREE.Box3(
        center.clone().add(new THREE.Vector3(-0.1, -0.1, -0.1)),
        center.clone().add(new THREE.Vector3(0.1, 0.1, 0.1))
      ),
      enabled: true,
      tracking: true,
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      velocityAt(_point, out) { return out.set(0, 0, 0); },
    };
    const ball = {
      mesh: { position: position.clone() },
      velocity: velocity.clone(),
      spin: new THREE.Vector3(),
      active: true,
      frozen: false,
      touchedByPaddle: false,
      velocityAt(_point, out) { return out.set(0, 0, 0); },
    };
    const physics = new PhysicsWorld();
    for (let i = 0; i < 120 && !ball.touchedByPaddle; i += 1) {
      physics.step(1 / 240, [ball], [paddle]);
    }
    assert.equal(ball.touchedByPaddle, true, `serve should reach the ${toNet < 0 ? 'host' : 'guest'} bat`);
    assert.ok(ball.velocity.dot(paddle.bladeNormal) > 0, 'the ball rebounds back toward the net');
  }
});

test('held serve is placed on the default contact point for either player side', () => {
  const player = createHeldServePosition();
  assert.equal(player.y, TABLE.HEIGHT + 0.19);
  assert.equal(player.z, PLAY_AREA.PLAYER_Z - HELD_SERVE_DEPTH);
  assert.equal(player.x, 0);

  const guest = createHeldServePosition({ side: -1, x: -0.2 });
  assert.equal(guest.y, HELD_SERVE_HEIGHT);
  assert.equal(guest.z, -(PLAY_AREA.PLAYER_Z - HELD_SERVE_DEPTH));
  assert.equal(guest.x, -0.2);
});

test('held serve bob stays inside the paddle face rather than jumping out of reach', () => {
  const ball = Object.create(Ball.prototype);
  const origin = createHeldServePosition();
  ball.mesh = { position: new THREE.Vector3() };
  ball.serve = (position) => { ball.mesh.position.copy(position); };
  Ball.prototype.holdForServe.call(ball, origin);

  assert.ok(ball.serveToss.amplitude <= 0.04);
  assert.ok(ball.serveToss.angularSpeed <= 2.5);
  assert.equal(ball.mesh.position.y, origin.y + HELD_SERVE_BOB);
  ball.updateServeToss(Math.PI / (2 * HELD_SERVE_BOB_SPEED));
  assert.ok(Math.abs(ball.mesh.position.y - origin.y) < 1e-9);
});
