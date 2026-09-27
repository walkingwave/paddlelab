import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

// Paddle materials use a procedural canvas texture; only fillRect is needed by
// this geometry setup, so no browser or renderer is required.
globalThis.document ??= {
  createElement() {
    return { width: 1, height: 1, getContext: () => ({ fillRect() {} }) };
  },
};

const [{ Paddle }, { PhysicsWorld }, { PADDLE }, { applyRemotePaddle }] = await Promise.all([
  import('../src/paddle.js'),
  import('../src/physics.js'),
  import('../src/constants.js'),
  import('../src/net/versusPackets.js'),
]);

function makeBall(position, velocity) {
  return {
    mesh: { position: position.clone() },
    velocity: velocity.clone(),
    spin: new THREE.Vector3(),
    frozen: false,
    serveToss: null,
    touchedByPaddle: false,
    velocityAt(point, out) { return out.set(0, 0, 0); },
  };
}

test('the visible bounds track the paddle face in world space for any parent pose', () => {
  const rig = new THREE.Group();
  const paddle = new Paddle();
  rig.add(paddle.mesh);
  const scene = new THREE.Scene();
  scene.add(rig, paddle.boundsHelper);
  rig.position.set(0.4, 1.1, 2.2);
  rig.rotation.set(0.2, 0.7, -0.1);
  paddle.mesh.visible = true;
  paddle.enabled = true;
  paddle.update(1 / 90);
  paddle.update(1 / 90);

  assert.equal(paddle.tracking, true);
  assert.equal(paddle.boundsValid, true);
  assert.equal(paddle.boundsHelper.visible, true);

  const bladePosition = paddle._blade.getWorldPosition(new THREE.Vector3());
  const bladeRotation = paddle._blade.getWorldQuaternion(new THREE.Quaternion());
  const axes = [
    new THREE.Vector3(1, 0, 0).applyQuaternion(bladeRotation),
    new THREE.Vector3(0, 1, 0).applyQuaternion(bladeRotation),
  ];
  for (const axis of axes) {
    for (const direction of [-1, 1]) {
      const edge = bladePosition.clone().addScaledVector(axis, direction * paddle.headRadius * 0.999);
      assert.equal(paddle.bounds.containsPoint(edge), true, 'the box encloses each face edge');
    }
  }
  // The profile extends the handle down its local -Y axis; its middle should
  // still be inside the bounds even though it is well outside the collision face.
  const handleMiddle = paddle._profile.localToWorld(new THREE.Vector3(0, -0.15, 0));
  assert.equal(paddle.bounds.containsPoint(handleMiddle), true, 'the box encloses the handle');

  const previousBounds = paddle.bounds.clone();
  assert.equal(paddle.previousBounds.equals(previousBounds), true, 'the last tracked bounds are retained');

  // Move the paddle across a stationary ball along its face normal. The ball
  // starts between the two sampled poses, so only the swept broad/narrow phase
  // can detect this contact.
  rig.rotation.set(0, 0, 0);
  rig.position.set(-0.2, 0, 0);
  paddle.update(1 / 90);
  paddle.update(1 / 90);
  const startCenter = paddle.bladeCenter.clone();
  const stationaryBall = makeBall(startCenter.clone().addScaledVector(paddle.bladeNormal, 0.2), new THREE.Vector3());
  const ballPrevious = stationaryBall.mesh.position.clone();
  const startBounds = paddle.bounds.clone();
  rig.position.x += 0.4;
  paddle.update(1 / 90);
  assert.ok(paddle.bladeCenter.x > startCenter.x + 0.3);
  assert.equal(paddle.bounds.containsPoint(paddle.bladeCenter), true);
  assert.equal(paddle.previousBounds.equals(startBounds), true, 'the previous sampled bounds are retained');
  const physics = new PhysicsWorld();
  let hits = 0;
  physics.onBounce = (_ball, event) => { if (event === 'paddle') hits += 1; };
  physics._collidePaddle(stationaryBall, paddle, ballPrevious);
  assert.equal(stationaryBall.touchedByPaddle, true, 'a moving paddle crossing a stationary ball is not culled');
  assert.equal(hits, 1);
});

test('the world-space bounds reject distant paths but preserve swept face contact', () => {
  const rig = new THREE.Group();
  const paddle = new Paddle();
  rig.add(paddle.mesh);
  rig.updateMatrixWorld(true);
  paddle.enabled = true;
  paddle.mesh.visible = true;
  paddle.update(1 / 90);
  paddle.update(1 / 90);

  const physics = new PhysicsWorld();
  let hits = 0;
  physics.onBounce = (_ball, event) => { if (event === 'paddle') hits++; };
  const center = paddle.bladeCenter.clone();
  const normal = paddle.bladeNormal.clone();

  const distant = makeBall(center.clone().add(new THREE.Vector3(2, 2, 2)), new THREE.Vector3(0, 0, -3));
  physics._collidePaddle(distant, paddle, distant.mesh.position.clone().add(new THREE.Vector3(0, 0, 0.1)));
  assert.equal(distant.touchedByPaddle, false);
  assert.equal(hits, 0);

  // The sphere crosses the thin blade slab in one step, so collision still
  // depends on the swept narrow phase after the AABB broad-phase accepts it.
  const ball = makeBall(
    center.clone().addScaledVector(normal, -0.1),
    normal.clone().multiplyScalar(3)
  );
  const previous = center.clone().addScaledVector(normal, 0.1);
  ball.velocity.copy(normal).negate().multiplyScalar(3);
  physics._collidePaddle(ball, paddle, previous);
  assert.equal(ball.touchedByPaddle, true);
  assert.equal(ball.lastHitBy, paddle);
  assert.equal(hits, 1);
});

test('networked paddles keep their collision face and visible bounds on the received pose', () => {
  const scene = new THREE.Scene();
  const paddle = new Paddle();
  scene.add(paddle.mesh, paddle.boundsHelper);
  const center = new THREE.Vector3(0.4, 1.2, -0.8);
  const normal = new THREE.Vector3(0.3, 0.2, 0.93).normalize();
  assert.equal(applyRemotePaddle(paddle, {
    c: center.toArray(), n: normal.toArray(), v: [0, 0, 0], t: true,
  }), true);

  paddle.mesh.updateWorldMatrix(true, true);
  paddle.updateBounds();
  assert.ok(paddle.bladeCenter.distanceTo(center) < 1e-8);
  assert.ok(paddle.bladeNormal.distanceTo(normal) < 1e-8);
  assert.equal(paddle.bounds.containsPoint(center), true);
  assert.equal(paddle.boundsHelper.visible, true);

  const rig = new THREE.Group();
  const nested = new Paddle();
  scene.add(rig);
  rig.position.set(-0.5, 0.3, 0.2);
  rig.rotation.y = 0.5;
  rig.add(nested.mesh);
  const expectedCenter = new THREE.Vector3(-0.2, 1.0, -0.4);
  const expectedNormal = new THREE.Vector3(0.2, 0.1, 0.97).normalize();
  // Convert a known desired world pose into the parent's coordinate space.
  assert.equal(applyRemotePaddle(nested, {
    c: expectedCenter.toArray(), n: expectedNormal.toArray(), v: [0, 0, 0], t: true,
  }), true);
  nested.mesh.updateWorldMatrix(true, true);
  nested.updateBounds();
  assert.ok(nested.bladeCenter.distanceTo(expectedCenter) < 1e-8);
  assert.ok(nested.bladeNormal.distanceTo(expectedNormal) < 1e-8);
});

test('paddle bounds expand when changing desktop/hand scale', () => {
  const rig = new THREE.Group();
  const paddle = new Paddle();
  rig.add(paddle.mesh);
  rig.updateMatrixWorld(true);
  paddle.update(1 / 90);
  const before = paddle.bounds.getSize(new THREE.Vector3());

  paddle.setScale(1.4);
  paddle.updateBounds();
  const after = paddle.bounds.getSize(new THREE.Vector3());
  assert.ok(after.x > before.x * 1.35 || after.y > before.y * 1.35 || after.z > before.z * 1.35);
  assert.ok(after.length() > before.length());
  assert.ok(paddle.headRadius >= PADDLE.HEAD_RADIUS * 1.4 - 1e-9);
});
