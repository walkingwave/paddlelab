import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { createTable } from './table.js';
import { XRManager } from './xr.js';
import { UI } from './ui.js';
import { Settings } from './settings.js';
import { Sfx } from './audio.js';
import { VRMenu } from './vrMenu.js';
import { Paddle, DESKTOP_PADDLE_SCALE } from './paddle.js';
import { Ball } from './ball.js';
import { PhysicsWorld } from './physics.js';
import { BallMachine, MODES } from './ballMachine.js';
import { Game, SCOREBOARD_POSITION } from './game.js';
import { Scoreboard } from './hud.js';
import { TargetZone } from './target.js';
import { HandPaddleRig } from './handPaddle.js';
import { PaddleSourceRouter, PADDLE_SOURCE } from './paddleSource.js';
import { TRACKER_STATE } from './vision/trackerState.js';
import { startHandTracking } from './handTracking.js';
import { HandPaddlePose } from './vision/handPose.js';
import { Opponent } from './opponent.js';
import { FlyBrain } from './flybrain.js';
import { FlyBrainViz } from './flybrain/flyBrainViz.js';
import { Coach, SCENARIOS } from './coach.js';
import {
  createRoom,
  createTournamentRoom,
  makeRoomCode,
  makeTournamentPlayerId,
  roomLinkFor,
  roomFromUrl,
  roomRelayFromUrl,
  clearRoomFromUrl,
  clearTournamentFromUrl,
  isRealtimeAvailable,
  relayConfigured,
  tournamentFromUrl,
  tournamentLinkFor,
} from './net.js';
import { encodeBladePacket, applyRemotePaddle, VERSUS_RECONNECT_LIMIT, versusReconnectDelay } from './net/versusPackets.js';
import { DESKTOP_KEYS, bindDesktopKeys } from './input/desktopKeys.js';
import { createTuningPanel } from './webcamTuningPanel.js';
import { createPhonePair } from './net/phonePair.js';
import { VersusMatch } from './versus.js';
import { Tournament, RESULT_STATUS, TOURNAMENT_SIZE } from './tournament.js';
import { createHeldServePosition, createServeToss } from './serve.js';
import { summarizeMatch, analyzeShot, narrate, recordProfileEvent, recordTelemetry, getProfileSummary } from './backendApi.js';
import { PLAY_AREA, TABLE, COLORS, BALL } from './constants.js';

const BALL_POOL_SIZE = 10;
const DEAD_BALL_LINGER = 1.5; // seconds a dead ball stays visible before recycling

// --- Renderer / scene -------------------------------------------------------
// alpha:true so the framebuffer is transparent in AR — the Quest compositor
// shows camera passthrough wherever nothing is drawn.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const VR_BACKGROUND = new THREE.Color(0x0a0a0b);
scene.background = VR_BACKGROUND;

// A baked room probe gives every material sensible reflections, which is most
// of the difference between "untextured boxes" and "objects in a space".
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  60
);

// Player rig: move this group to reposition the player in the world.
// In XR the camera is controlled by the headset relative to this rig.
const playerRig = new THREE.Group();
playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
playerRig.add(camera);
scene.add(playerRig);

// Desktop fallback camera position (headset overrides this in XR)
camera.position.set(0, 1.62, 0);

// --- Lighting ---------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xc8d6f0, 0x1d1712, 0.32));

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(2.5, 5, 1.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 14;
keyLight.shadow.camera.left = -3;
keyLight.shadow.camera.right = 3;
keyLight.shadow.camera.top = 4;
keyLight.shadow.camera.bottom = -4;
keyLight.shadow.bias = -0.0012;
scene.add(keyLight);
scene.add(keyLight.target);

// Overhead venue light, the sort that hangs above a match table. Kept soft
// and wide — a tight, bright cone blows the playing surface out to white and
// destroys the depth cues you need to read the ball against it.
const venueLight = new THREE.SpotLight(0xffffff, 9, 11, Math.PI / 3.2, 0.9, 1.4);
venueLight.position.set(0, 3.6, 0);
venueLight.target.position.set(0, TABLE.HEIGHT, 0);
scene.add(venueLight);
scene.add(venueLight.target);

// --- World ------------------------------------------------------------------
const table = createTable();
scene.add(table);
const vrEnvironment = table.getObjectByName('vr-environment');

const settings = new Settings();
const sfx = new Sfx(settings);

const balls = Array.from({ length: BALL_POOL_SIZE }, () => new Ball());
for (const b of balls) scene.add(b.mesh);

const machine = new BallMachine(balls, settings);
machine.enabled = false; // stays idle behind the start menu until a mode is picked
scene.add(machine.mesh);

// Puts the table in front of you, wherever you happen to be standing and
// whichever way you are facing.
//
// The floor-level origin a headset hands back is wherever the guardian was
// drawn, which is rarely where you want to stand to play. Rather than ask
// the player to walk to the right spot, move the world: rotate the rig so
// the head faces down the table, then slide it so the head lands at the
// player's end.
const UP = new THREE.Vector3(0, 1, 0);
const _headLocal = new THREE.Vector3();
const _headEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function recenter() {
  // On a screen there is no head to centre on. The camera is posed by the
  // game, so reading it back and correcting for it just walked the player a
  // few centimetres off the stance both ends of a versus match assume. Put
  // them back where they should be standing instead.
  if (!renderer.xr.isPresenting) {
    playerRig.position.set(0, 0, netMode === 'guest' ? -PLAY_AREA.PLAYER_Z : PLAY_AREA.PLAYER_Z);
    playerRig.rotation.y = netMode === 'guest' ? Math.PI : 0;
    playerRig.updateMatrixWorld(true);
    ui.toast('View reset');
    return;
  }

  // Head pose relative to the rig is exactly what the headset reports
  _headEuler.setFromQuaternion(camera.quaternion, 'YXZ');
  playerRig.rotation.y = -_headEuler.y;

  _headLocal.copy(camera.position).applyAxisAngle(UP, playerRig.rotation.y);
  playerRig.position.set(
    -_headLocal.x,
    0,
    PLAY_AREA.PLAYER_Z - _headLocal.z
  );
  playerRig.updateMatrixWorld(true);
  ui.toast('Table recentred');
}

// Sweep every ball back into the pool. Without this, balls still in flight
// when you quit stay airborne behind the menu and are still hanging there
// when the next session starts.
function clearBalls() {
  for (const ball of balls) ball.deactivate();
}

const game = new Game();
const scoreboard = new Scoreboard(game, machine);
scene.add(scoreboard.mesh);

// Ring showing where the next ball is aimed — the trainer's single most
// useful cue, since it tells you where to move before the ball arrives.
const targetRing = new THREE.Mesh(
  new THREE.RingGeometry(BALL.RADIUS * 3, BALL.RADIUS * 4.2, 32),
  new THREE.MeshBasicMaterial({
    color: COLORS.ACCENT,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
);
targetRing.rotation.x = -Math.PI / 2;
scene.add(targetRing);

// Target-practice pad on the far half
const targetZone = new TargetZone();
scene.add(targetZone.mesh);

// Rally opponent. Its bat is an ordinary Paddle handed to the physics
// alongside yours, so its returns come out of the same contact model —
// real spin, real restitution, and a net cord behaves like a net cord.
const opponent = new Opponent();
scene.add(opponent.mesh);
scene.add(opponent.paddle.boundsHelper);
machine.server = opponent; // in rally mode the opponent puts the ball in play

// The "Fly brain" difficulty: paddle placement read out of a fruit fly's
// connectome, used as a fixed reservoir. Without the exported model file
// (public/flybrain/model.json — built on the flybrain branch) it plays a
// near-perfect analytic intercept instead, so the difficulty always works.
const flyBrain = new FlyBrain();
// The fallback predicts to the fly's own hitting plane; point it at ours.
flyBrain.planeZ = -(TABLE.LENGTH / 2) - 0.1;
flyBrain.load().then((ok) => {
  if (ok) console.info('[FlyBrain] connectome model loaded');
});
opponent.brain = flyBrain;
const flyBrainViz = new FlyBrainViz(flyBrain);
flyBrainViz.mount();
flyBrainViz.hide();

// Coach mode: a lesson is a path the bat should travel, shown as a ribbon
// and scored on how closely you trace it.
const coach = new Coach({
  sfx,
  onScore: (score) => {
    game.onLessonScore(score);
    ui.showCoachScore(score, coach.scenario.id);
    // Backend coaching is optional. The local lesson remains fully usable when
    // no provider keys are configured, while deployed builds can add a second
    // opinion and persist a compact profile event.
    analyzeShot(score, { scenario: coach.scenario.id, advice: coach.advice })
      .then(({ analysis }) => {
        ui.showCoachFeedback(analysis);
        ui.setCoachProfileStatus('OPENAI');
        narrateCoach(analysis, 'a');
      })
      .catch(() => {
        ui.setCoachProfileStatus('LOCAL');
        // ElevenLabs can still read the local stroke correction when the
        // optional OpenAI call is unavailable.
        narrateCoach(score.note || coach.advice, 'a');
      });
    const playerId = settings.get('playerId') || 'anonymous';
    recordProfileEvent(
      { type: 'coach_score', scenario: coach.scenario.id, score },
      playerId
    )
      .then(() => ui.setCoachProfileStatus('PROFILE SYNCED'))
      .catch(() => {});
    recordTelemetry({
      player_id: playerId,
      event_type: 'coach_score',
      scenario: coach.scenario.id,
      total: score.total,
      path: score.path,
      sync: score.sync,
      face: score.face,
      timing: score.timing,
      payload: score,
    }).catch(() => {});
  },
});
scene.add(coach.group);
scoreboard.coach = coach; // the board shows the lesson's guidance line

// Picking a scenario off the in-world board is the same action as picking
// it in the menu, so the setting follows along.
coach.onScenarioPicked = (scenario) => {
  settings.set('scenario', scenario.id);
  ui.toast(scenario.name);
  game.revision++;
};

// The bottom bar names the running scenario without needing the coach
Object.defineProperty(machine, 'coachName', {
  get: () => coach.scenario.name,
});

// AR: transparent background, no virtual floor, dimmer fill so the real room
// carries the lighting. VR: full venue.
function applyMode(mode) {
  const isAR = mode === 'immersive-ar';
  scene.background = isAR ? null : VR_BACKGROUND;
  if (vrEnvironment) vrEnvironment.visible = !isAR;
  venueLight.visible = !isAR;
  keyLight.intensity = isAR ? 0.9 : 1.5;
}

const xr = new XRManager(renderer);
xr.onModeChange = (mode) => {
  applyMode(mode);
  // A session can end without warning — headset removed, system menu, battery.
  // Close the in-world pause menu so it isn't still hanging there, open and
  // holding input, the next time a session starts.
  if (!mode) vrMenu.toggle(false);
  if (mode) {
    stopHandPaddle();
    stopWebcamBat();
  } else if (ui.menu.hidden) {
    syncCameraInput();
    syncDesktopCursor();
  }
};

const ui = new UI({
  xr,
  machine,
  game,
  settings,
  sfx,
  // `mode` is an XR session mode, or null for the on-screen preview. The
  // desktop build being developed separately hooks in here.
  onStart: (mode) => {
    clearBalls();
    // A versus match is served by the host over the network, so the ball
    // machine stays down for it.
    machine.enabled = !['versus', 'tournament'].includes(settings.get('game'));
    game.reset();
    const selectedGame = settings.get('game');
    if (selectedGame === 'tournament') {
      const rallyIndex = MODES.findIndex((entry) => entry.type === 'rally');
      if (rallyIndex >= 0) machine.modeIndex = rallyIndex;
      ui.updateTournament(tournament.snapshot());
    }
    ui.showCoachReady(
      selectedGame === 'tournament'
        ? `Tournament · ${tournament.opponent?.name ?? 'Opponent'}`
        : selectedGame === 'coach'
          ? `Coach · ${coach.scenario.name}`
          : selectedGame === 'versus'
            ? 'Match coaching ready'
            : 'Live shot coaching ready'
    );
    // The camera only opens once you are actually playing, not while the
    // setting sits there remembered from last time.
    if (!mode) syncCameraInput();
    syncDesktopCursor();
    getProfileSummary(settings.get('playerId') || 'anonymous')
      .then(({ summary }) => {
        ui.showProfileSummary(summary);
        narrateCoach(summary, 'b');
      })
      .catch(() => {});
    if (settings.get('difficulty') === 'fly') flyBrainViz.show();
  },
  onExit: () => {
    machine.enabled = false;
    leaveTournament();
    clearBalls();
    stopWebcamBat();
    stopHandPaddle();
    phonePair.close();
    renderer.domElement.style.cursor = '';
    flyBrainViz.hide();
  },
  isInputBlocked: () => vrMenu.open,
  onRecenter: () => {
    if (handSession) {
      if (!handPose.recenter()) return ui.toast('Show your hand before recentering');
      desktopRig.position.copy(handPose.position);
      desktopPaddle.resetTracking();
      ui.toast('Hand paddle recentred');
    } else recenter();
  },

  // Online versus. The lobby in the shell calls these; everything about how
  // the match actually runs lives in enterVersus / leaveVersus below. Both
  // are hoisted function declarations, so naming them here is safe.
  onVersusCreate: async (transport = 'auto', relay = null) => {
    const code = makeRoomCode();
    const room = await enterVersus('host', code, transport, relay);
    // Prefer a LAN address the other device can actually open — `localhost`
    // means nothing to a headset across the room.
    const origin = relay ? window.location.origin : room?.lanUrls?.[0] || window.location.origin;
    // `room.role` rather than 'host': over the LAN relay the server decides by
    // arrival, so hosting a code someone else already opened makes you the
    // guest. Telling the player otherwise would be a lie about which end of
    // the table they are on.
    return {
      role: room.role,
      code,
      link: roomLinkFor(code, origin, relay),
      // Read through, not snapshotted: a WebRTC room that falls back to the
      // relayed channel reports that instead of claiming a direct link.
      get kind() { return room.kind; },
    };
  },
  onVersusJoin: async (code, transport = 'auto', relay = null) => {
    const room = await enterVersus('guest', code.trim().toUpperCase(), transport, relay);
    return { role: room.role, code, get kind() { return room.kind; } };
  },
  onVersusLeave: () => leaveVersus(),
  onTournamentCreate: () => createTournamentLobby(),
  onTournamentJoin: (code) => joinTournamentLobby(code),
  onTournamentStart: () => startTournamentBracket(),
  onTournamentLeave: () => leaveTournament(),
  onTournamentDispute: () => overrideTournamentDispute(),
  onTournamentLaunch: (assignment) => enterTournamentMatch(assignment),
  onPhonePair: () => phonePair.open(),
  // What the run was worth, read at the moment you quit. Versus is scored on
  // what you took off a real opponent; the other two on the trainer's stats.
  onRunSummary: () => ({
    hits: game.hits,
    misses: game.misses,
    returns: game.returns,
    bestStreak: game.bestStreak,
    longestRally: game.longestRally,
    targetsHit: game.targetsHit,
    accuracy: game.accuracy,
    lessonBest: game.lessonBest,
    lessonAttempts: game.lessonAttempts,
    pointsWon: settings.get('game') === 'tournament'
      ? tournamentPointsWon()
      : netMode === 'guest'
        ? match.scoreGuest
        : match.scoreHost,
    matchWon: settings.get('game') === 'tournament'
      ? tournament.finished && tournament.championId === tournamentLobby?.player?.id
      : Boolean(netMode) && match.winner === netMode,
  }),
  // A link with ?room=CODE means someone invited you: the lobby opens on the
  // join step with the code already filled in.
  invitedRoom: roomFromUrl(),
  invitedTournament: tournamentFromUrl(),
  invitedRelay: roomRelayFromUrl(),
  realtimeAvailable: isRealtimeAvailable(),
  relayAvailable: relayConfigured(),
});

xr.detectSupport().then((support) => ui.applyXRSupport(support));

// --- Live per-shot coaching -----------------------------------------------
// Coach drills already score a traced stroke. This companion score covers
// ordinary balls as well, using only measurements we can trust at contact:
// outgoing pace/direction, blade orientation, and generated spin. It gives
// the player immediate local guidance, then lets the server replace that line
// with OpenAI's single precise correction when credentials are available.
let lastLiveCoachAt = -Infinity;
let liveCoachRequestActive = false;
let pendingLiveCoachRequest = null;
let lastNarrationFailureAt = -Infinity;

// Do not hide a broken voice path. In particular, localhost's Vite server
// does not serve Vercel Functions, and browser autoplay can reject playback.
function narrateCoach(text, narrator = 'a') {
  return narrate(text, narrator).catch((error) => {
    console.warn('[Coach narration]', error);
    ui.setCoachProfileStatus('VOICE ERROR');
    const now = performance.now();
    if (now - lastNarrationFailureAt < 4500) return;
    lastNarrationFailureAt = now;
    const message = error?.message?.includes('Vercel dev')
      ? 'Coach voice needs Vercel dev or the deployed app'
      : error?.name === 'NotAllowedError'
        ? 'Coach voice is blocked — click the speaker'
        : 'Coach voice unavailable — check ElevenLabs';
    ui.toast(message);
  });
}

function percent(value) {
  return Math.round(THREE.MathUtils.clamp(value, 0, 100));
}

function assessLiveShot(ball, paddle) {
  const speed = ball.velocity.length();
  const towardOpponent = speed > 1e-4 ? Math.max(0, -ball.velocity.z / speed) : 0;
  const pace = percent((speed / 7) * 100);
  const depth = percent(towardOpponent * 100);
  const face = percent(Math.abs(paddle.bladeNormal.z) * 100);
  const spin = percent((ball.spin.length() / 180) * 100);
  const total = percent(pace * 0.28 + depth * 0.42 + face * 0.2 + spin * 0.1);

  let note = 'Nice contact — stay balanced and recover for the next ball.';
  if (depth < 58) note = 'Finish forward through the ball so the return clears the net.';
  else if (pace < 24) note = 'Accelerate through contact; let the paddle carry the ball deep.';
  else if (face < 52) note = 'Square the paddle face a little more at contact.';
  else if (Math.abs(ball.velocity.x) > Math.abs(ball.velocity.z) * 0.72) {
    note = 'Keep your path straighter through contact before adding width.';
  }

  return {
    label: settings.get('game') === 'tournament'
      ? `Tournament shot · ${tournament.opponent?.name ?? 'Opponent'}`
      : 'Live stroke',
    total,
    pace,
    depth,
    face,
    spin,
    note,
    outgoingSpeed: Math.round(speed * 100) / 100,
    outgoingDirection: {
      x: Math.round(ball.velocity.x * 100) / 100,
      y: Math.round(ball.velocity.y * 100) / 100,
      z: Math.round(ball.velocity.z * 100) / 100,
    },
  };
}

function requestLiveCoachAnalysis(request) {
  liveCoachRequestActive = true;
  const { shot, playerId, game: gameMode, opponent: opponentName } = request;
  analyzeShot(shot, {
    game: gameMode,
    player: playerId,
    opponent: opponentName,
  })
    .then(({ analysis }) => {
      // A newer stroke arrived while this one was being analyzed. Let the
      // queued request produce the correction instead of talking about a
      // ball the player has already moved past.
      if (pendingLiveCoachRequest || !analysis) return;
      ui.showCoachFeedback(analysis);
      ui.setCoachProfileStatus('OPENAI');
      narrateCoach(analysis, 'a');
    })
    .catch(() => {
      if (pendingLiveCoachRequest) return;
      ui.setCoachProfileStatus('LOCAL');
      narrateCoach(shot.note, 'a');
    })
    .finally(() => {
      liveCoachRequestActive = false;
      const next = pendingLiveCoachRequest;
      pendingLiveCoachRequest = null;
      if (next) requestLiveCoachAnalysis(next);
    });
}

function coachLiveShot(ball, paddle) {
  // Guided lessons already emit their own richer trace score, and the bot's
  // paddle is not the player we are coaching.
  if (machine.isCoachMode || paddle?.isOpponent) return;
  const now = performance.now();
  if (now - lastLiveCoachAt < 850) return;
  lastLiveCoachAt = now;

  const shot = assessLiveShot(ball, paddle);
  const playerId = settings.get('playerId') || 'anonymous';
  ui.showLiveCoachShot(shot);

  const telemetry = {
    player_id: playerId,
    event_type: 'live_shot',
    scenario: settings.get('game'),
    total: shot.total,
    path: shot.depth,
    sync: shot.pace,
    face: shot.face,
    timing: shot.spin,
    payload: shot,
  };
  recordTelemetry(telemetry).catch(() => {});
  recordProfileEvent({ type: 'live_shot', shot }, playerId).catch(() => {});

  const request = {
    shot,
    playerId,
    game: settings.get('game'),
    opponent: settings.get('game') === 'tournament' ? tournament.opponent?.name : undefined,
  };
  // Keep one analysis in flight, but retain the newest shot rather than
  // invalidating the one about to speak. That was the reason fast rallies
  // could result in no ElevenLabs narration at all.
  if (liveCoachRequestActive) {
    pendingLiveCoachRequest = request;
    return;
  }
  requestLiveCoachAnalysis(request);
}

// --- Physics ----------------------------------------------------------------
const physics = new PhysicsWorld();
physics.onBounce = (ball, event, paddle) => {
  sfx.contact(event, ball.velocity.length());

  // Online versus scores itself. The host resolves floor bounces into points;
  // the guest never simulates the match ball at all, so it has no contacts of
  // its own to interpret.
  if (netMode) {
    if (netMode === 'host') handleVersusHostBounce(ball, event);
    return;
  }

  // The coach's live drills report where your return actually went, so it
  // needs to see what happens to the ball it served.
  coach.onBallEvent(ball, event, paddle);

  if (event === 'paddle' && !paddle?.isOpponent) {
    coachLiveShot(ball, paddle);
  }

  // The opponent's returns arrive through the same contact path as yours,
  // so they have to be told apart: one is an exchange in the rally, the
  // other is a hit on your scorecard.
  if (event === 'paddle' && paddle?.isOpponent) {
    game.onRallyExchange();
    opponent.onHit();
    return;
  }

  game.onContact(ball, event);

  if (event === 'paddle') {
    pulse(ball);
    return;
  }

  if (event === 'floor' && settings.get('game') === 'tournament') {
    handleTournamentFloor(ball);
    return;
  }

  // A return that lands inside the pad scores and moves the target on.
  if (
    event === 'table' &&
    machine.isTargetMode &&
    ball.touchedByPaddle &&
    !ball.scoredTarget &&
    ball.mesh.position.z < 0 &&
    targetZone.contains(ball.mesh.position.x, ball.mesh.position.z)
  ) {
    ball.scoredTarget = true;
    targetZone.registerHit();
    game.onTargetHit();
    sfx.targetHit();
  }

  // Floor contact means the rally is over for this ball; start a countdown
  // that returns it to the pool. Timed in simulation seconds rather than via
  // setTimeout so it can't drift when the browser throttles the frame loop.
  if (event === 'floor' && ball.retireIn === null) {
    ball.retireIn = DEAD_BALL_LINGER;
    // A ball on the floor ends the rally, whoever put it there.
    if (machine.isRallyMode) {
      game.endRally(ball.touchedByPaddle ? 'Rally over' : 'Missed');
    }
  }
};

// --- Controllers + paddles --------------------------------------------------
const controllerModelFactory = new XRControllerModelFactory();
const paddles = [];
const controllers = [];
const inputSources = [];

// Ray drawn from each controller, shown only while the VR menu is up
const rayGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -1),
]);

const controllerModels = [];
const handRigs = [];
const paddleSources = [];

for (const i of [0, 1]) {
  // Grip space is the controller's physical pose, so a mesh parented here
  // inherits the tracked position and orientation every frame — the paddle
  // is the controller, one to one, with no smoothing or lag of our own.
  const grip = renderer.xr.getControllerGrip(i);
  const model = controllerModelFactory.createControllerModel(grip);
  grip.add(model);
  controllerModels.push(model);
  playerRig.add(grip);

  const paddle = new Paddle();
  paddle.attachTo(grip);
  scene.add(paddle.boundsHelper);
  paddles.push(paddle);

  // Hand tracking, so the bat can follow your actual hand holding a real
  // paddle instead of a controller. The hand space is a sibling of the grip;
  // the router below decides which one the mesh hangs off each frame.
  const hand = renderer.xr.getHand(i);
  playerRig.add(hand);
  const handRig = new HandPaddleRig(hand, i === 0 ? 'right' : 'left');
  playerRig.add(handRig.group);
  handRigs.push(handRig);

  // Parent for poses fed in from outside the page — a camera-based tracker
  // running elsewhere. Nothing writes to it until such a feed connects.
  const externalRoot = new THREE.Group();
  playerRig.add(externalRoot);

  paddleSources.push(
    new PaddleSourceRouter({
      paddle,
      controllerGrip: grip,
      handRig,
      externalRoot,
    })
  );

  const controller = renderer.xr.getController(i);
  controller.addEventListener('connected', (e) => {
    inputSources[i] = e.data;
    applyHandedness();
  });
  controller.addEventListener('disconnected', () => {
    inputSources[i] = null;
    applyHandedness();
  });

  // Trigger: picks menu entries while the menu is up, otherwise arms or
  // pauses the machine.
  controller.addEventListener('selectstart', () => {
    if (vrMenu.open) {
      vrMenu.activate();
    } else {
      machine.enabled = !machine.enabled;
      game.revision++;
    }
  });
  controller.addEventListener('squeezestart', () => {
    if (vrMenu.open) return;
    machine.nextDrill();
    game.revision++;
  });

  const ray = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color: COLORS.ACCENT, transparent: true, opacity: 0.6 })
  );
  ray.scale.z = 3;
  ray.visible = false;
  controller.add(ray);
  controller.userData.ray = ray;

  controllers.push(controller);
  playerRig.add(controller);
}

// --- Desktop bat ------------------------------------------------------------
// A headset gives you a bat because there is a tracked hand to hang it on. On
// a screen there is nothing to hang it on, so the pointer drives a rig parented
// under playerRig: mouse X/Y place the blade in a small volume over the near
// half of the table, the wheel (or a click, or F) moves it in depth.
//
// The pose is written straight from the event with no smoothing of our own, and
// depth is eased toward a target rather than snapped, so Paddle.update() derives
// a real swing velocity from the motion between frames — exactly as it does
// from a grip. A thrust therefore carries momentum into the ball instead of
// teleporting through it.
//
// This is what lets someone at a laptop play a match against someone in a
// headset; it also means the desktop preview can rally rather than just watch.
const desktopRig = new THREE.Group();
playerRig.add(desktopRig);
const desktopPaddle = new Paddle();
// Mouse, webcam-marker and hand-tracked play all go through this one bat;
// they all get the enlarged flat-screen size. The grip paddles above stay
// life-size for the headset.
desktopPaddle.setScale(DESKTOP_PADDLE_SCALE);
desktopPaddle.attachTo(desktopRig);
scene.add(desktopPaddle.boundsHelper);
desktopPaddle.enabled = false; // switched on below whenever we're not in XR
desktopPaddle.mesh.visible = false;
paddles.push(desktopPaddle);

const DESKTOP_REST_Z = -0.72; // blade's resting depth, a little in front of you
// A swing adds pace; it does not relocate the bat.
//
// The first version lunged 46 cm forward, which moved the plane the ball was
// about to cross out from under it — every click turned a clean contact into
// a miss (18 hits without swinging, 0 with). What a stroke needs to add is
// speed at the moment of contact, so this is now a short push at a believable
// hand speed, and the depth it reaches is a few centimetres rather than half
// the length of your arm.
const DESKTOP_THRUST_DEPTH = 0.14; // metres forward at the top of the swing
const DESKTOP_THRUST_TIME = 0.1; // seconds pushing before it comes back
const DESKTOP_THRUST_SPEED = 1.5; // m/s — the bat's own pace, not a teleport
const DESKTOP_DRIVE_PITCH = 0.3; // radians the face closes at full stroke
const DESKTOP_WHEEL_DEPTH_STEP = 0.08; // metres per wheel notch

// The wheel nudges the bat nearer or further than where it would meet the
// ball, for anyone who wants to take it early or late. A bias rather than an
// absolute depth, so it composes with the ball-meeting above instead of
// fighting it.
let desktopDepthBias = 0;
let desktopThrust = 0;
let desktopRecover = 0; // time left before another stroke can start

// Where the player is asking the *blade* to be, in rig space. Kept separate
// from the rig's own position because the blade sits up and back from the
// paddle's origin, on the end of a handle: put the rig under the cursor and
// the blade ends up ten-odd centimetres away, which against an 85 mm blade is
// the difference between playing the ball and missing everything. The rig
// position is derived from this each frame — never nudged, or the offset
// would be subtracted again on every mouse move and the bat would walk off
// down the table.
const desktopAim = new THREE.Vector3(0, 0.95, DESKTOP_REST_Z);
const _bladeOffset = new THREE.Vector3();

// The bat goes where the cursor points, rather than somewhere derived from it.
//
// The first version mapped the window onto a fixed box — which meant the reach
// was whatever those numbers happened to be, and they were wrong: ±0.62 m of
// swing against a table ±0.76 m wide, so the corners were physically
// unreachable no matter how far you moved the mouse. Un-projecting the cursor
// through the camera onto the plane the bat plays in removes the guesswork:
// the blade sits under the pointer, and it keeps doing so as the view follows
// the bat, which a fixed mapping cannot.
const HALF_TABLE_X = TABLE.WIDTH / 2;
const REACH_X = HALF_TABLE_X + 0.22; // a little past the edge, as you can reach
const REACH_Y_TOP = 1.62; // about shoulder height; above that is not a stroke
// Balls that clip the near edge drop well below the table before they reach
// you, and the bat plays behind the end of the table, not over it — so the
// old floor at table height meant a low ball was simply unreachable. Knee
// height is both playable and honest: you can get under a low one.
const REACH_Y_BOTTOM = 0.35;
const _pointerNdc = new THREE.Vector2();
const _pointerRay = new THREE.Raycaster();
const _batPlane = new THREE.Plane();
const _planePoint = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _hit = new THREE.Vector3();
let pointerActive = false;

function placeDesktopBat(clientX, clientY) {
  if (renderer.xr.isPresenting || handSession) return; // controllers or the hand own the bats
  _pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
  _pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
  pointerActive = true;
}

// Resolve the cursor onto the bat's plane. Done per frame rather than per
// pointer event, because the plane moves: depth tracks the incoming ball and
// the camera rides the bat, so the same cursor position means a different
// world point a frame later.
function aimDesktopBatAtPointer() {
  if (!pointerActive) return;

  // The plane the bat plays in: upright, facing down the table, at the bat's
  // current depth. Built in world space from the rig so a flipped guest rig
  // needs no special case.
  _planePoint.set(0, 0, desktopAim.z);
  playerRig.localToWorld(_planePoint);
  _planeNormal.set(0, 0, 1).applyQuaternion(playerRig.quaternion);
  _batPlane.setFromNormalAndCoplanarPoint(_planeNormal, _planePoint);

  // Aimed through a fixed reference view, never the live camera.
  //
  // The live one follows the bat, and the bat is placed by un-projecting the
  // cursor through a camera — so using it closes a loop: move the mouse, the
  // bat moves, the camera chases it, and the same cursor position now means
  // somewhere else, so the bat slides again. It settles eventually and feels
  // like the bat is swimming away from the pointer the whole time. A fixed
  // reference view makes a cursor position mean exactly one place on the
  // plane, always, and leaves the camera free to drift for feel.
  _pointerRay.setFromCamera(_pointerNdc, camera);
  if (!_pointerRay.ray.intersectPlane(_batPlane, _hit)) return;

  playerRig.worldToLocal(_hit);
  meetIncomingBall(_hit);
  desktopAim.x = THREE.MathUtils.clamp(_hit.x, -REACH_X, REACH_X);
  desktopAim.y = THREE.MathUtils.clamp(_hit.y, REACH_Y_BOTTOM, REACH_Y_TOP);
  desktopYaw = (desktopAim.x / REACH_X) * 0.5;
}

// A bat's face is perpendicular to the forearm, so the blade points along the
// rig's +X, not down its -Z: a quarter turn is what squares it to the table.
// (Half a turn leaves it edge-on, which passes straight through the ball and
// is very hard to see.) Horizontal position adds a little steer on top, the
// way turning your wrist aims a real return.
let desktopYaw = 0;

function poseDesktopBat() {
  // Close the face as you drive. A flat bat at 5 m/s puts every ball long —
  // which it should, that is what a flat bat does. Angling it down over the
  // ball is how the shot is actually kept on the table, so the swing does it
  // for you, in proportion to how far through the stroke you are.
  const drive = THREE.MathUtils.clamp(desktopThrust / DESKTOP_THRUST_TIME, 0, 1);

  const phonePose = phonePair.lastPose;
  const phonePitch =
    settings.get('paddleSource') === PADDLE_SOURCE.PHONE && phonePose
      ? THREE.MathUtils.clamp((phonePose.pitch ?? 0) / 70, -0.42, 0.42)
      : 0;
  const phoneRoll =
    settings.get('paddleSource') === PADDLE_SOURCE.PHONE && phonePose
      ? THREE.MathUtils.clamp((phonePose.roll ?? 0) / 70, -0.35, 0.35)
      : 0;
  desktopRig.rotation.set(
    -drive * DESKTOP_DRIVE_PITCH + phonePitch,
    Math.PI / 2 + desktopYaw,
    phoneRoll
  );
  desktopRig.quaternion.setFromEuler(desktopRig.rotation);
  _bladeOffset
    .copy(desktopPaddle.mesh.getObjectByName('blade').position)
    // The blade's local offset scales with the enlarged desktop bat; without
    // this the aim point sat a handle-length away from the blade.
    .multiplyScalar(DESKTOP_PADDLE_SCALE)
    .applyQuaternion(desktopRig.quaternion);
  desktopRig.position.copy(desktopAim).sub(_bladeOffset);
}

// Which depth the bat should hold for the ball in play.
//
// Held, not chased — a bat that tracks the ball's depth never lets it cross
// the blade. But the resting depth only suits a ball that is coming at you.
// Target practice lobs one straight up in front of the player, and it came
// down twenty-odd centimetres short of the resting plane: the bat sat beyond
// it, the ball fell past untouched, and the mode simply could not be played on
// a screen. So the plane is picked once per ball and then held there.
const PLANE_LOB_SPEED = 0.8; // m/s of approach below which a ball is a lob
const LOB_STAND_OFF = 0.07; // metres the blade stands behind a hanging ball
const _planeBallLocal = new THREE.Vector3();
const _planeRigInverse = new THREE.Quaternion();
let planeBall = null; // the ball the current plane was chosen for
let planeDepth = DESKTOP_REST_Z;

function desktopPlaneDepth() {
  _planeRigInverse.copy(playerRig.quaternion).invert();

  // The ball this player has to deal with: on their side, still in play.
  let candidate = null;
  let candidateZ = -Infinity;
  for (const ball of balls) {
    if (!ball.active) continue;
    _planeBallLocal.copy(ball.mesh.position);
    playerRig.worldToLocal(_planeBallLocal);
    if (_planeBallLocal.z > 0.2 || _planeBallLocal.z < -1.8) continue;
    if (_planeBallLocal.z > candidateZ) {
      candidateZ = _planeBallLocal.z;
      candidate = ball;
    }
  }

  if (!candidate) {
    planeBall = null;
    planeDepth = DESKTOP_REST_Z;
    return planeDepth;
  }
  if (candidate === planeBall) return planeDepth; // already chosen; hold it

  planeBall = candidate;
  _planeBallLocal.copy(candidate.velocity).applyQuaternion(_planeRigInverse);
  // A ball driven at you will cross the resting plane on its own. A lob will
  // not, so the plane moves out to where it is hanging instead.
  // For a lob the plane sits a little nearer the player than the ball, not
  // level with it. Level, the ball descends onto the edge of the blade and
  // which side it is counted as arriving from — and so which way it leaves —
  // comes down to rounding: half of them were knocked back toward the player
  // rather than down the table. Behind it, the ball is always on the far side
  // of the face and a stroke always sends it the way the player is facing.
  planeDepth =
    _planeBallLocal.z > PLANE_LOB_SPEED
      ? DESKTOP_REST_Z
      : THREE.MathUtils.clamp(candidateZ + LOB_STAND_OFF, -1.1, -0.25);
  return planeDepth;
}

function swingDesktopBat() {
  if (renderer.xr.isPresenting || handSession) return;
  // One stroke at a time. Retriggering while a swing is running kept topping
  // the timer up, so a held mouse button parked the bat at the end of its
  // push — stationary, which is the one thing a bat must not be when the ball
  // arrives. Balls came off a held "swing" slower than off no swing at all.
  if (desktopThrust > 0 || desktopRecover > 0) return;
  desktopThrust = DESKTOP_THRUST_TIME;
  desktopRecover = DESKTOP_THRUST_TIME * 1.6; // long enough to get back
}

// Close the last few centimetres onto a ball you are already tracking.
//
// Not a favour to bad aim — a correction for a gap the game creates. The ball
// covers about 7 cm between frames and the blade is 8.5 cm across, so a
// cursor sitting exactly on the ball is, by the time physics runs, most of a
// blade behind it. Every ball then passes a hand's width from the bat, which
// is precisely how it felt: unhittable for no visible reason.
//
// So: predict where the ball crosses the plane, and if the cursor is already
// close, pull the blade the rest of the way. Bounded, and it does nothing if
// you are not near the ball — miss by a wide margin and you still miss.
// Screen-space: how near the cursor has to be, as a fraction of half the
// viewport. Roughly a thumb's width — enough to cover the parallax between a
// ball in flight and the plane it will cross, not enough to play for you.
// Two profiles: a hand is a far coarser pointer than a mouse, so the webcam
// paddle earns a wider catch radius, a stronger pull, and a longer look-ahead
// — it assists a player who is already roughly right, it does not play for
// them. The mouse keeps the light touch it was tuned with.
const ASSIST_PROFILES = {
  mouse: { range: 0.14, max: 0.16, slew: 0.9, horizon: 0.12 },
  // The webcam profile is a live view onto the tuning panel's values.
  webcam: {
    get range() { return webcamTuning.assistRange; },
    get max() { return webcamTuning.assistPull; },
    get slew() { return webcamTuning.assistSlew; },
    get horizon() { return webcamTuning.assistHorizon; },
  },
};
let assist = ASSIST_PROFILES.mouse;
const assistOffset = new THREE.Vector2();
const _meetLocal = new THREE.Vector3();
const _meetVel = new THREE.Vector3();
const _meetWorld = new THREE.Vector3();
const _rigInverse = new THREE.Quaternion();

function meetIncomingBall(aim) {
  _rigInverse.copy(playerRig.quaternion).invert();

  let bestDistance = Infinity;
  let foundX = 0;
  let foundY = 0;

  for (const ball of balls) {
    if (!ball.active) continue;
    _meetLocal.copy(ball.mesh.position);
    playerRig.worldToLocal(_meetLocal);
    _meetVel.copy(ball.velocity).applyQuaternion(_rigInverse);

    // Only a ball still coming at you, and only once it is close enough that
    // you would actually be playing it.
    if (_meetVel.z < 0.5) continue;
    // A short horizon on purpose. Predicting further means predicting through
    // the bounce this ball still has to take off the table, and a straight
    // line through a bounce lands the blade somewhere the ball was never
    // going — which pulled it away from balls the player had lined up
    // perfectly. Inside a tenth of a second the flight is simple and the
    // prediction is worth trusting.
    const toPlane = aim.z - _meetLocal.z;
    if (toPlane < 0 || toPlane > 0.34) continue;

    const t = toPlane / _meetVel.z;
    if (t > assist.horizon) continue;
    const x = _meetLocal.x + _meetVel.x * t;
    const y = _meetLocal.y + _meetVel.y * t - 0.5 * 9.81 * t * t;

    // Matched on screen, not on the plane.
    //
    // The player puts the cursor on the ball they can see, and that ball is
    // still short of the plane the bat plays in. The ray through it therefore
    // meets the plane somewhere else entirely — higher and off to one side,
    // by about eight centimetres at this camera angle — so a blade placed
    // there misses a ball that was lined up perfectly. Comparing where the
    // ball *will* be against where the cursor *is*, both in screen terms,
    // measures the thing the player was actually aiming at.
    _meetWorld.set(x, y, aim.z);
    playerRig.localToWorld(_meetWorld);
    _meetWorld.project(camera);
    const distance = Math.hypot(_meetWorld.x - _pointerNdc.x, _meetWorld.y - _pointerNdc.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      foundX = x;
      foundY = y;
    }
  }

  // Slewed, never snapped.
  //
  // Jumping the blade onto the ball is self-defeating: the bat derives its
  // swing speed from how far it moved since last frame, so a 14 cm correction
  // reads as an 8 m/s lunge. Contact is then rejected as the bat moving away
  // from the ball faster than the ball is arriving — and on the occasions it
  // did connect it would have fired the ball off the table. Creeping the
  // correction in over several frames leaves the bat's velocity honest, which
  // is what the ball comes off.
  let wantX = 0;
  let wantY = 0;
  if (bestDistance <= assist.range) {
    // Strength comes from how close the cursor is on screen; the direction
    // and size of the correction are in metres, on the plane.
    const strength = 1 - bestDistance / assist.range;
    const gapX = foundX - aim.x;
    const gapY = foundY - aim.y;
    const gap = Math.hypot(gapX, gapY);
    if (gap > 1e-4) {
      const pull = Math.min(assist.max, gap) * strength;
      wantX = (gapX / gap) * pull;
      wantY = (gapY / gap) * pull;
    }
  }

  const step = assist.slew / 60; // metres per frame
  assistOffset.x += THREE.MathUtils.clamp(wantX - assistOffset.x, -step, step);
  assistOffset.y += THREE.MathUtils.clamp(wantY - assistOffset.y, -step, step);
  aim.x += assistOffset.x;
  aim.y += assistOffset.y;
}

// --- Webcam bat -------------------------------------------------------------
// The flat-screen counterpart to hand tracking: a webcam watches your actual
// paddle and drives the on-screen one, so a laptop player swings a real bat
// rather than pushing a mouse. The tracker finds the rubber by colour and
// reads pose off the blob's ellipse — see vision/paddleTracker.js.
//
// It feeds the same rig the pointer drives, so everything downstream (swing
// velocity, spin, versus packets) is identical either way; only where the pose
// comes from changes.
let camTracker = null;
let webcamHasLocked = false; // pointer drives until the first marker lock
let camTrackerLoading = false;

function usingWebcamBat() {
  return settings.get('paddleSource') === PADDLE_SOURCE.CAMERA;
}

// The marker tracker is a 585 kB chunk plus a worker and an 11 MB WebAssembly
// build that only appear once a camera pipeline actually starts. Importing it
// from the entry module made every visitor — including a phone opening the
// pairing page, which never touches the marker tracker at all — download it
// before the menu could paint. It is fetched on demand instead, the first time
// a camera-driven paddle is wanted.
let markerTrackerModule = null;
function loadMarkerTracker() {
  markerTrackerModule ??= import('./vision/markerPaddleTracker.js');
  return markerTrackerModule;
}

// The phone pairing session — its room, the desktop camera that locates the
// phone, and the last pose the phone sent. Created once and reused, so opening
// and closing the pairing screen does not rebuild the tracker.
const phonePair = createPhonePair({
  ui,
  loadTracker: loadMarkerTracker,
  onStop: () => assistOffset.set(0, 0),
});

async function startWebcamBat() {
  if (camTracker || camTrackerLoading) return;
  camTrackerLoading = true;
  let MarkerPaddleTracker;
  try {
    ({ MarkerPaddleTracker } = await loadMarkerTracker());
  } catch {
    ui.toast('The webcam paddle tracker could not be loaded');
    return;
  } finally {
    camTrackerLoading = false;
  }
  // The mode can be switched off while the chunk is in flight.
  if (camTracker || !usingWebcamBat()) return;
  camTracker = new MarkerPaddleTracker();
  camTracker.onState = (state, error) => {
    // The preview carries the running commentary; toasts are for the moments
    // that change what the player should do.
    if (state === TRACKER_STATE.ERROR) {
      ui.setCamStatus(error ?? 'Camera unavailable');
      ui.toast(error ?? 'Camera unavailable');
    } else if (state === TRACKER_STATE.CALIBRATING) {
      ui.setCamStatus('Show the marker side of the paddle');
      ui.toast('Show the printed markers to the camera — click to set neutral');
    } else if (state === TRACKER_STATE.TRACKING) {
      ui.setCamStatus('Tracking · flick to swing · V re-zeros · T tunes');
    } else if (state === TRACKER_STATE.LOST) {
      ui.setCamStatus('Lost the markers — show the paddle face');
    }
  };
  ui.showCamPreview(camTracker);
  camTracker.start().catch((err) => {
    ui.toast(err?.message ?? 'Camera failed');
    stopWebcamBat();
  });
}

function stopWebcamBat() {
  webcamHasLocked = false;
  webcamPrevZ = null;
  webcamZVel = 0;
  camTracker?.stop();
  camTracker = null;
  ui.showCamPreview(null);
}

// Keep the computercam pose/filter pipeline intact. Camera poses arrive at
// 30 Hz, independently of rendering: sample velocity only on fresh poses.
let handSession = null;
let handPose = null;
let handSeenAt = -Infinity;

function syncCameraInput() {
  const playing = ui.menu.hidden && !renderer.xr.isPresenting;
  const hand = playing && settings.get('paddleSource') === 'camera-hand';
  if (!hand) stopHandPaddle();
  if (!playing || !usingWebcamBat()) stopWebcamBat();
  if (hand) startHandPaddle();
  else if (playing && usingWebcamBat()) startWebcamBat();
}

// In mouse play the paddle already marks the pointer's exact position. Keeping
// the browser cursor there makes it look like a second, stray paddle marker.
// Restore it for menus, webcam setup, and XR where it remains useful.
function syncDesktopCursor() {
  const mousePlay =
    ui?.menu?.hidden &&
    !renderer.xr.isPresenting &&
    settings.get('paddleSource') === PADDLE_SOURCE.CONTROLLER;
  renderer.domElement.style.cursor = mousePlay ? 'none' : '';
}

function startHandPaddle() {
  if (handSession) return;
  stopWebcamBat();
  const session = new AbortController();
  handSession = session;
  handPose = new HandPaddlePose();
  desktopPaddle.setPalmTrackingMode(true);
  desktopRig.position.copy(handPose.position);
  desktopRig.quaternion.copy(handPose.quaternion);
  const fail = (error) => {
    if (handSession !== session) return;
    stopHandPaddle();
    ui.toast(`${error?.message ?? 'Hand camera unavailable'} — using mouse`);
  };
  startHandTracking((sample) => {
    if (handSession !== session) return;
    const result = sample && handPose.update(sample);
    if (!result) {
      handPose.markLost();
      desktopPaddle.resetTracking();
      return;
    }
    handSeenAt = performance.now();
    if (result.reacquired) desktopPaddle.resetTracking();
    desktopRig.position.copy(handPose.position);
    desktopRig.quaternion.copy(handPose.quaternion);
    desktopPaddle.updateFromCamera(sample.timestamp);
  }, (status) => {
    if (handSession === session) ui.toast(status);
  }, { signal: session.signal, onError: fail }).catch(fail);
}

function stopHandPaddle() {
  if (!handSession) return;
  const session = handSession;
  handSession = null;
  session.abort();
  handPose = null;
  handSeenAt = -Infinity;
  desktopPaddle.setPalmTrackingMode(false);
  poseDesktopBat();
}

window.addEventListener('pagehide', () => {
  stopHandPaddle();
  stopWebcamBat();
});

// The webcam paddle drives the AIM POINT, not the blade.
//
// The first integration mapped the marker pose straight onto the blade —
// six degrees of freedom, exactly what the tracker measures. It was
// unusable, and the reason is instructive: blade angle came from raw board
// tilt, but holding the paddle at a natural stroke angle foreshortens the
// markers the tracker needs, so the angle you cannot help changing is the
// one measured worst. Every contact came off a slightly different, slightly
// wrong face. Depth had the same flaw — the player cannot perceive their
// hand's distance to a virtual plane, so measured depth was noise they
// couldn't correct.
//
// The mouse paddle is playable precisely because it synthesises those two
// channels: the face angle follows the aim, the depth holds a plane, and a
// swing is a discrete, repeatable thrust. So the hand now does what the
// mouse does — moves the aim point — through that same proven path, aim
// assist included. What the hand adds over a mouse is the swing itself:
// flick the paddle toward the screen and the thrust fires, which is the
// same motion as an actual stroke.
const WEBCAM_REST = new THREE.Vector3(0, 0.95, DESKTOP_REST_Z);

// Everything that decides how the webcam paddle FEELS, in one tunable
// bundle. Feel cannot be dialled in from measurements alone — it depends on
// the player's camera, room, and reach — so the panel on the T key exposes
// these live and persists what the player settles on.
const WEBCAM_TUNING_KEY = 'paddlelab-webcam-tuning';
const WEBCAM_DEFAULTS = {
  gainX: 2.2, // virtual metres per real metre, sideways
  gainY: 1.6, // and vertically
  stiffness: 16, // per second; higher = snappier, noisier
  maxSpeed: 6, // m/s ceiling on paddle travel
  swingSpeed: 0.35, // m/s push toward the camera that counts as a swing
  swingCooldown: 0.45,
  lead: 0.06, // seconds of latency the predictor hides
  assistRange: 0.24, // screen fraction where the pull engages
  assistPull: 0.26, // metres it may move the paddle
  assistSlew: 1.8, // m/s the pull creeps in at
  assistHorizon: 0.18, // seconds ahead the crossing is predicted
  camEase: 3.5, // how lazily the view follows the paddle
};
const webcamTuning = { ...WEBCAM_DEFAULTS };
try {
  Object.assign(webcamTuning, JSON.parse(localStorage.getItem(WEBCAM_TUNING_KEY)) ?? {});
} catch {
  // corrupt entry — defaults are fine
}
function saveWebcamTuning() {
  try {
    localStorage.setItem(WEBCAM_TUNING_KEY, JSON.stringify(webcamTuning));
  } catch {
    // private browsing; the sliders still work for this session
  }
}
let webcamPrevZ = null;
let webcamZVel = 0;
let webcamSwingCooldown = 0;
const _aimWorld = new THREE.Vector3();

// Critically-damped chase of the hand. The tracker's own filter runs at
// camera cadence and still passes pixel-level noise; written straight into
// the aim that noise became visible paddle tremble. The spring eats it while
// staying inside a frame or two of a real swing — and because a solve spike
// now moves the aim at a bounded rate instead of teleporting it, it doubles
// as the last line against jump glitches.
function driveAimFromPhone(dt) {
  const tracker = phonePair.tracker;
  if (!tracker) return;
  const displacement = tracker.position;
  const targetX = THREE.MathUtils.clamp(
    WEBCAM_REST.x + displacement.x * webcamTuning.gainX,
    -REACH_X,
    REACH_X
  );
  const targetY = THREE.MathUtils.clamp(
    WEBCAM_REST.y + displacement.y * webcamTuning.gainY,
    REACH_Y_BOTTOM,
    REACH_Y_TOP
  );
  const ease = 1 - Math.exp(-Math.max(webcamTuning.stiffness, 18) * dt);
  const maxStep = Math.max(webcamTuning.maxSpeed, 6) * dt;
  desktopAim.x += THREE.MathUtils.clamp((targetX - desktopAim.x) * ease, -maxStep, maxStep);
  desktopAim.y += THREE.MathUtils.clamp((targetY - desktopAim.y) * ease, -maxStep, maxStep);

  // Once CV has identified the phone marker board, reuse the existing bounded
  // ball-catching assist. The phone position remains authoritative; assist
  // only closes the small final gap to an incoming ball.
  _aimWorld.copy(desktopAim);
  playerRig.localToWorld(_aimWorld);
  _aimWorld.project(camera);
  _pointerNdc.set(_aimWorld.x, _aimWorld.y);
  assist = ASSIST_PROFILES.webcam;
  meetIncomingBall(desktopAim);
  assist = ASSIST_PROFILES.mouse;
  desktopAim.x = THREE.MathUtils.clamp(desktopAim.x, -REACH_X, REACH_X);
  desktopAim.y = THREE.MathUtils.clamp(desktopAim.y, REACH_Y_BOTTOM, REACH_Y_TOP);
  desktopYaw = (desktopAim.x / REACH_X) * 0.5;
}

function driveAimFromWebcam(dt) {
  camTracker.predictionLead = webcamTuning.lead;
  const displacement = camTracker.position;

  const targetX = THREE.MathUtils.clamp(
    WEBCAM_REST.x + displacement.x * webcamTuning.gainX,
    -REACH_X,
    REACH_X
  );
  const targetY = THREE.MathUtils.clamp(
    WEBCAM_REST.y + displacement.y * webcamTuning.gainY,
    REACH_Y_BOTTOM,
    REACH_Y_TOP
  );
  const ease = 1 - Math.exp(-webcamTuning.stiffness * dt);
  const maxStep = webcamTuning.maxSpeed * dt;
  desktopAim.x += THREE.MathUtils.clamp((targetX - desktopAim.x) * ease, -maxStep, maxStep);
  desktopAim.y += THREE.MathUtils.clamp((targetY - desktopAim.y) * ease, -maxStep, maxStep);
  desktopYaw = (desktopAim.x / REACH_X) * 0.5;

  // Route the existing aim assist: it compares the predicted crossing with
  // the cursor on screen, so stand the paddle's own aim point in for the
  // cursor by projecting it through the camera.
  _aimWorld.copy(desktopAim);
  playerRig.localToWorld(_aimWorld);
  _aimWorld.project(camera);
  _pointerNdc.set(_aimWorld.x, _aimWorld.y);
  assist = ASSIST_PROFILES.webcam;
  meetIncomingBall(desktopAim);
  assist = ASSIST_PROFILES.mouse;
  desktopAim.x = THREE.MathUtils.clamp(desktopAim.x, -REACH_X, REACH_X);
  desktopAim.y = THREE.MathUtils.clamp(desktopAim.y, REACH_Y_BOTTOM, REACH_Y_TOP);

  // Swing on a forward flick. Displacement +Z is toward the screen (depth
  // shrinking), so a fast positive z-rate is the stroke gesture.
  if (webcamPrevZ !== null && dt > 0) {
    const rate = (displacement.z - webcamPrevZ) / dt;
    webcamZVel = webcamZVel * 0.6 + rate * 0.4;
  }
  webcamPrevZ = displacement.z;
  webcamSwingCooldown -= dt;
  if (
    webcamZVel > webcamTuning.swingSpeed &&
    webcamSwingCooldown <= 0 &&
    camTracker.confidence > 0.4
  ) {
    swingDesktopBat();
    webcamSwingCooldown = webcamTuning.swingCooldown;
  }
}

// --- Webcam tuning panel ------------------------------------------------
// Feel is personal and room-dependent, so rather than shipping one guess,
// T opens sliders over every parameter above. Values persist per browser.
const tuningPanel = createTuningPanel({
  tuning: webcamTuning,
  defaults: WEBCAM_DEFAULTS,
  save: saveWebcamTuning,
});

placeDesktopBat(window.innerWidth / 2, window.innerHeight * 0.55);

window.addEventListener('pointermove', (e) => placeDesktopBat(e.clientX, e.clientY), {
  passive: true,
});
window.addEventListener('pointerdown', (e) => {
  if (!ui.menu.hidden) return; // the menu owns its own clicks
  // The webcam tracker has to be shown the bat's colour once. Any click while
  // it is waiting is that gesture, so there is no separate key to learn.
  if (camTracker?.state === TRACKER_STATE.CALIBRATING) {
    if (!camTracker.calibrateColour()) ui.toast('No markers seen yet — bring the paddle closer');
    return;
  }
  placeDesktopBat(e.clientX, e.clientY);
  swingDesktopBat();
});
window.addEventListener(
  'wheel',
  (e) => {
    if (renderer.xr.isPresenting || !ui.menu.hidden || handSession) return;
    desktopDepthBias = THREE.MathUtils.clamp(
      desktopDepthBias - Math.sign(e.deltaY) * DESKTOP_WHEEL_DEPTH_STEP,
      -0.25,
      0.25
    );
  },
  { passive: true }
);

bindDesktopKeys({
  isBlocked: () => !ui.menu.hidden,
  onCommand: (event) => {
    // Re-learn the bat's colour without leaving the game. Lighting changes as
    // you move around a room, and a key beats going back to the menu for it.
    if (event.code === 'KeyT' && usingWebcamBat()) {
      tuningPanel.toggle();
      return true;
    }
    if (event.code === 'KeyV' && camTracker) {
      if (camTracker.calibrateColour()) ui.toast('Neutral pose re-zeroed');
      else ui.toast('Show the markers to the camera first');
      return true;
    }
    // Which way an ambiguous tilt is read, for the rare case it latches on to
    // the wrong sign — a paddle leaning away looks identical to one leaning
    // toward the camera, so this cannot be resolved from the image alone.
    if (event.code === 'KeyB' && camTracker) {
      camTracker.flipTilt();
      ui.toast('Paddle tilt flipped');
      return true;
    }
    return false;
  },
  onSwing: () => swingDesktopBat(),
});

function updateDesktopBat(dt) {
  const inXR = renderer.xr.isPresenting;
  desktopPaddle.enabled = !inXR;
  desktopPaddle.mesh.visible = !inXR;

  // Outside a session the controller bats are attached to grips that sit at
  // the rig origin — on the floor, at the player's feet. They report that pose
  // perfectly well, so physics treats them as live bats and they swat balls
  // nobody can see. Stand them down until a session actually poses them.
  for (const paddle of paddles) {
    if (paddle === desktopPaddle) continue;
    paddle.enabled = inXR && (paddle.handHolds ?? true);
    paddle.mesh.visible = paddle.enabled;
  }

  if (inXR) return;

  if (handSession) {
    if (performance.now() - handSeenAt > 250) {
      handPose.markLost();
      desktopPaddle.resetTracking();
    }
    return;
  }

  // Once the webcam paddle has locked on, the hand owns the aim point for as
  // long as the mode is selected. On a dropout the aim simply stays where it
  // was — the tracker holds its last displacement — so losing the markers
  // parks the paddle instead of teleporting it to the mouse pose. Everything
  // below (plane depth, thrust, face angle, pose) is the same code the mouse
  // runs, so the two inputs feel identical to hit with.
  const phoneDriving = settings.get('paddleSource') === PADDLE_SOURCE.PHONE;
  if (phoneDriving) {
    pointerActive = false;
    const tracker = phonePair.tracker;
    if (phonePair.identified) phonePair.aimLockTime = Math.min(phonePair.aimLockTime + dt, 1);
    else phonePair.aimLockTime = Math.max(0, phonePair.aimLockTime - dt * 2.5);
    phonePair.aimAssistActive = phonePair.aimLockTime >= 0.25;

    if (phonePair.aimAssistActive) {
      driveAimFromPhone(dt);
    } else if (tracker?.state === TRACKER_STATE.TRACKING) {
      // Before the object is identified, CV may only park the paddle at the
      // measured centre. Aim assist stays completely off during this phase.
      desktopAim.x = THREE.MathUtils.clamp(tracker.position.x * 2.2, -REACH_X, REACH_X);
      desktopAim.y = THREE.MathUtils.clamp(0.95 + tracker.position.y * 1.65, REACH_Y_BOTTOM, REACH_Y_TOP);
      assistOffset.set(0, 0);
    } else {
      phonePair.aimAssistActive = false;
      assistOffset.set(0, 0);
    }
    // Phone orientation owns the face direction/tilt, while flick still owns
    // the stroke gesture. CV never tries to infer wrist rotation.
    const phonePose = phonePair.lastPose;
    if (phonePose) {
      // Phone IMU owns orientation. Keep location entirely in the camera
      // tracker so device-specific sensor drift cannot move the paddle around.
      desktopYaw = THREE.MathUtils.clamp((phonePose.roll ?? 0) / 70, -0.35, 0.35);
      if (phonePose.flick) {
        swingDesktopBat();
        phonePose.flick = false;
      }
    }
  } else if (usingWebcamBat() && camTracker?.state === TRACKER_STATE.TRACKING) {
    webcamHasLocked = true;
  }
  const webcamDriving = usingWebcamBat() && camTracker && webcamHasLocked;
  if (phoneDriving) {
    // Phone pose is already expressed as a normalized aim point above.
  } else if (webcamDriving) {
    pointerActive = false; // the mouse no longer fights the hand
    if (camTracker.state === TRACKER_STATE.TRACKING) driveAimFromWebcam(dt);
  } else {
    aimDesktopBatAtPointer();
  }

  // Held arrow keys slide the blade at a steady rate; the mouse overrides on
  // its next move, which is what you'd expect from whichever you touched last.
  const speed = 1.1; // m/s
  const dx = (DESKTOP_KEYS.ArrowRight - DESKTOP_KEYS.ArrowLeft) * speed * dt;
  const dy = (DESKTOP_KEYS.ArrowUp - DESKTOP_KEYS.ArrowDown) * speed * dt;
  if (dx || dy) {
    pointerActive = false; // keys have the bat until the mouse moves again
    desktopAim.x = THREE.MathUtils.clamp(desktopAim.x + dx, -REACH_X, REACH_X);
    desktopAim.y = THREE.MathUtils.clamp(desktopAim.y + dy, REACH_Y_BOTTOM, REACH_Y_TOP);
    desktopYaw = (desktopAim.x / REACH_X) * 0.5;
  }

  if (desktopThrust > 0) desktopThrust -= dt;
  if (desktopRecover > 0) desktopRecover -= dt;

  // The bat holds a plane and lets the ball come to it.
  //
  // Chasing the ball's depth instead — which sounds more helpful — is why it
  // felt unhittable: the bat tracked along with the ball, the gap between them
  // stayed at a stubborn 15 cm, and the ball never actually crossed the blade.
  // A held plane is crossed by anything that reaches you, which turns the
  // problem back into aiming, and aiming is what a mouse is good at.
  const target =
    desktopPlaneDepth() + desktopDepthBias - (desktopThrust > 0 ? DESKTOP_THRUST_DEPTH : 0);
  // Moved at a hand's pace rather than snapped, so the velocity Paddle.update
  // derives from it is one a person could actually produce — that velocity is
  // what the ball comes off, and it is also what the contact test uses to tell
  // a stroke from the bat running away.
  const step = (desktopThrust > 0 ? DESKTOP_THRUST_SPEED : DESKTOP_THRUST_SPEED * 0.6) * dt;
  desktopAim.z += THREE.MathUtils.clamp(target - desktopAim.z, -step, step);

  poseDesktopBat();
}

// ---------------------------------------------------------------------------
// Online versus (1v1)
//
// One side is authoritative. The host simulates the ball with the same physics
// the trainer uses and streams its position; the guest renders that and streams
// only its own bat. That asymmetry is what keeps the two views agreeing: there
// is exactly one simulation, so there is nothing to reconcile.
//
// Each player swings locally with no round trip, which is the part that has to
// feel immediate. The cost is that the host's bat is authoritative over
// contact, so a guest's return is resolved against a bat pose that is up to one
// network tick old — acceptable at 30 Hz over a LAN, and far better than
// waiting on an ack before the ball moves.
//
// While netMode is null every line below is dormant and the trainer behaves
// exactly as it did before.
// ---------------------------------------------------------------------------
let netMode = null; // null | 'host' | 'guest'
let room = null; // active room handle
const match = new VersusMatch();
const tournament = new Tournament();
// The shared bracket lobby lives for the whole tournament. `room` remains the
// active two-player table only, so people waiting in the other semifinal never
// receive another match's paddle or ball packets.
let tournamentLobby = null;
let tournamentStarted = false;
let tournamentMatch = null; // { id, player1, player2, opponent, code, playersByRole }
let tournamentTransition = false;
let tournamentLink = '';
let tournamentRevision = 0;
// Same idea as versusConfig: enough to reopen the lobby with the identity it
// already had if the transport drops mid-bracket.
let tournamentConfig = null; // { code, transport, relay, player }
let tournamentReconnectTimer = null;
let tournamentReconnectAttempts = 0;
// A finished match is only worth anything once both players have said how it
// ended. These track the agreement in flight and the grace timer that stops a
// dead opponent from stalling the bracket forever.
const TOURNAMENT_RESULT_GRACE_MS = 20_000;
let tournamentResultTimer = null;
let tournamentReportedMatchId = null;
let tournamentDisputedMatch = null;
let versusBall = null; // the rally ball (host authoritative)
let versusServeTimer = 0; // countdown before the host's next serve
let netSendAccum = 0; // throttle for outbound state
let guestBallActive = false;
// Enough to reopen the same room after the transport dies, without resetting a
// score that is still on the board.
let versusConfig = null; // { code, role, transport, relay }
let versusReconnectTimer = null;
let versusReconnectAttempts = 0;

const NET_TICK = 1 / 30; // 30 Hz, which is plenty for a ball and one bat
const VERSUS_SERVE_SECONDS = 3;

const guestBallTarget = new THREE.Vector3();

// The opponent's bat, driven entirely by network packets. It is handed to
// physics like any other paddle, so their shots come out of the same contact
// model as yours — real spin, real restitution.
const remotePaddle = new Paddle();
scene.add(remotePaddle.mesh);
scene.add(remotePaddle.boundsHelper);
remotePaddle.enabled = false;
remotePaddle.networked = true;
remotePaddle.mesh.visible = false; // nothing to show until a packet arrives

// Which bat this player is actually swinging — the one whose pose gets sent.
//
// Outside a session that is the pointer-driven bat. The controller bats are
// still "tracking" on a desktop, because they faithfully report the pose of a
// grip that is sitting at the rig origin, so picking the first tracked paddle
// would stream a bat parked at the player's feet.
function getLocalVersusPaddle() {
  if (!renderer.xr.isPresenting) return desktopPaddle;
  return (
    paddles.find(
      (paddle) => paddle !== desktopPaddle && paddle.enabled && paddle.tracking
    ) ?? paddles[0]
  );
}

function startVersusServe() {
  versusServeTimer = VERSUS_SERVE_SECONDS;
  ui.showCountdown(VERSUS_SERVE_SECONDS);
}

// Put the ball up in front of whoever is serving, for them to hit — rather
// than firing it across the table on their behalf. Every input source uses the
// same physical toss; only the paddle pose and swing come from a different
// device. The host still owns the simulation, including a guest's serve.
function serveVersusBall() {
  const ball = balls.find((b) => !b.active);
  if (!ball) return;

  // The host plays from +Z and the guest from -Z. Prefer the latest tracked
  // blade pose, but use the same calibrated stance fallback until the first
  // network/CV/controller sample arrives. This prevents a first serve from
  // being placed at the table centre or at an unreachable machine position.
  const toNet = match.server === 'host' ? -1 : 1;
  const serverIsLocal = match.server === netMode;
  const bat = serverIsLocal ? getLocalVersusPaddle() : remotePaddle;
  const side = match.server === 'host' ? 1 : -1;
  const center = createHeldServePosition({ side });
  const useTrackedPose = serverIsLocal && bat?.tracking && bat.bladeCenter.lengthSq() > 0.01;
  if (useTrackedPose) center.copy(bat.bladeCenter);
  center.y = THREE.MathUtils.clamp(center.y, TABLE.HEIGHT + 0.08, TABLE.HEIGHT + 0.62);

  const toss = createServeToss({
    center,
    toNet,
    normal: useTrackedPose ? bat.bladeNormal : null,
  });
  ball.serve(toss.position, toss.velocity);
  ball.floorCounted = false;
  ball.awaitingServeStrike = true; // a toss nobody hits is a re-serve, not a point
  versusBall = ball;
  broadcastHostState();
}

function broadcastHostState() {
  if (!room) return;
  const ball =
    versusBall && versusBall.active
      ? {
          active: true,
          p: [
            versusBall.mesh.position.x,
            versusBall.mesh.position.y,
            versusBall.mesh.position.z,
          ],
        }
      : { active: false, p: [0, 0, 0] };
  room.send('state', {
    match: match.snapshot(),
    ball,
    paddle: encodeBladePacket(getLocalVersusPaddle()),
  });
}

function tournamentPointsWon() {
  const localId = tournamentLobby?.player?.id;
  return tournament.matches.reduce((total, match) => {
    return total + (
      match.player1?.id === localId
        ? match.score1
        : match.player2?.id === localId
          ? match.score2
          : 0
    );
  }, 0);
}

function handleTournamentFloor(ball) {
  // A real tournament only scores through the authoritative host in
  // handleVersusHostBounce(). This is a guard for a stray local ball while a
  // bracket is still waiting in the lobby; it must never fabricate a bot
  // result into the shared bracket.
  if (!tournamentMatch || !netMode) {
    ball.deactivate();
    return;
  }
  if (ball.tournamentPointCounted || tournament.finished) return;
  ball.tournamentPointCounted = true;

  // A bounce that falls on the player's near (+Z) end means the bot won the
  // point; one on the far end means the player beat it. The bracket never
  // invents a result -- every point comes from this real ball outcome.
  const localPlayerId = tournamentLobby?.player?.id;
  const scorer = ball.mesh.position.z > 0 ? tournament.opponent?.id : localPlayerId;
  if (scorer == null) return;

  const playerId = settings.get('playerId') || 'anonymous';
  const current = tournament.currentMatch;
  game.endRally(scorer === localPlayerId ? 'Point won' : 'Point lost');
  ball.deactivate();
  const roundWinner = tournament.scorePoint(scorer);
  ui.updateTournament(tournament.snapshot());
  game.revision++;

  recordTelemetry({
    player_id: playerId,
    event_type: 'tournament_point',
    scenario: `round-${current?.round ?? 0}`,
    payload: {
      scorer: scorer === localPlayerId ? 'You' : tournament.playerById(scorer)?.name ?? 'Opponent',
      match: current?.id,
      score1: current?.score1,
      score2: current?.score2,
    },
  }).catch(() => {});

  if (roundWinner === null) return;
  if (!tournament.finished) {
    ui.toast(`Next match: ${tournament.opponent?.name ?? 'Opponent'}`);
    ui.showCoachReady(`Tournament · ${tournament.opponent?.name ?? 'Opponent'}`);
    return;
  }

  machine.enabled = false;
  const champion = roundWinner === localPlayerId;
  const matchResult = {
    type: 'tournament',
    champion: champion ? 'You' : tournament.playerById(roundWinner)?.name ?? 'Opponent',
    pointsWon: tournamentPointsWon(),
    matches: tournament.snapshot().matches,
  };
  ui.toast(champion ? 'Tournament champion!' : 'Tournament over');
  summarizeMatch(matchResult)
    .then(({ summary }) => {
      ui.showMatchSummary(summary);
      ui.setCoachProfileStatus('POST-MATCH');
      narrateCoach(summary, 'b');
    })
    .catch(() => {});
  recordProfileEvent({ type: 'tournament_result', ...matchResult }, playerId).catch(() => {});
  recordTelemetry({
    player_id: playerId,
    event_type: 'tournament_result',
    payload: matchResult,
  }).catch(() => {});
}

function handleVersusHostBounce(ball, event) {
  // The toss is live once it has been struck; until then it is not part of the
  // point at all.
  if (event === 'paddle' && ball === versusBall) ball.awaitingServeStrike = false;

  // A toss the server swung at and missed — or simply let drop — costs them
  // nothing but the re-serve. Scoring it would mean losing points to a fumbled
  // ball toss, which is not what anyone is playing for. Any contact that isn't
  // the bat ends it: a toss that lands, on the table or the floor, was not a
  // serve. (The table case matters — a ball that comes to rest up there never
  // reaches the floor, and the point would hang there forever.)
  if (ball === versusBall && !ball.floorCounted && ball.awaitingServeStrike) {
    ball.floorCounted = true;
    ball.deactivate();
    versusBall = null;
    broadcastHostState();
    startVersusServe();
    return;
  }

  if (event !== 'floor' || ball !== versusBall || ball.floorCounted) return;

  ball.floorCounted = true;
  // A ball that reaches the floor on the host's half (z>0) is one the host
  // failed to return, so the guest scores — and the other way around.
  const scorer = ball.mesh.position.z > 0 ? 'guest' : 'host';
  ball.deactivate();
  versusBall = null;
  const winner = match.scorePoint(scorer);
  ui.updateVersusScore(match.snapshot(), 'host');
  game.revision++; // repaint the in-world board
  broadcastHostState();
  if (winner) {
    if (tournamentMatch) {
      completeTournamentMatch(winner);
      return;
    }
    ui.showVersusWin(winner === 'host', match.snapshot());
    summarizeMatch({
      scoreHost: match.scoreHost,
      scoreGuest: match.scoreGuest,
      winner,
      server: match.server,
    })
      .then(({ summary }) => {
        ui.showMatchSummary(summary);
        narrateCoach(summary, 'b');
      })
      .catch(() => {});
    const playerId = settings.get('playerId') || 'anonymous';
    recordProfileEvent({
      type: 'versus_result',
      scoreHost: match.scoreHost,
      scoreGuest: match.scoreGuest,
      winner,
    }, playerId).catch(() => {});
    recordTelemetry({
      player_id: playerId,
      event_type: 'versus_result',
      payload: {
        scoreHost: match.scoreHost,
        scoreGuest: match.scoreGuest,
        winner,
      },
    }).catch(() => {});
  } else startVersusServe();
}

function runVersusHost(dt) {
  if (!match.winner && versusServeTimer > 0) {
    const previous = Math.ceil(versusServeTimer);
    versusServeTimer -= dt;
    if (versusServeTimer <= 0) {
      versusServeTimer = 0;
      ui.hideCountdown();
      serveVersusBall();
    } else if (Math.ceil(versusServeTimer) !== previous) {
      ui.showCountdown(Math.ceil(versusServeTimer));
    }
  }

  versusPaddles.length = 0;
  versusPaddles.push(...paddles, remotePaddle);
  for (const ball of balls) ball.updateServeToss(dt);
  physics.step(dt, balls, versusPaddles);

  // A ball that stops on the table never reaches the floor, so the point would
  // otherwise hang there with a dead ball sitting on the surface and neither
  // player able to do anything about it. Resting is just as final as landing:
  // resolve it the same way, on the half it came to rest on.
  if (versusBall?.active && versusBall.restingOn && !versusBall.floorCounted) {
    handleVersusHostBounce(versusBall, 'floor');
  }

  for (const ball of balls) {
    if (!ball.active) continue;
    ball.updateVisualSpin(dt);
    if (ball.mesh.position.length() > 14) ball.deactivate();
  }

  netSendAccum += dt;
  if (netSendAccum >= NET_TICK) {
    netSendAccum = 0;
    broadcastHostState();
  }
}

function applyHostState(state) {
  if (!state) return;
  if (!match.apply(state.match)) return;
  ui.updateVersusScore(match.snapshot(), 'guest');
  game.revision++;
  applyRemotePaddle(remotePaddle, state.paddle);

  if (state.ball?.active) {
    guestBallActive = true;
    guestBallTarget.set(state.ball.p[0], state.ball.p[1], state.ball.p[2]);
    if (!versusBall) versusBall = balls[0];
    // The guest renders the ball but never simulates it: keeping it inactive
    // keeps physics away from it, and the mesh is driven from packets.
    versusBall.active = false;
    versusBall.mesh.visible = true;
  } else {
    guestBallActive = false;
    if (versusBall) {
      versusBall.deactivate();
      versusBall = null;
    }
  }

  if (match.winner) {
    if (tournamentMatch) {
      reportTournamentOutcomeFromGuest();
      ui.showTournamentWaiting('Match complete — confirming the result…');
    } else {
      ui.showVersusWin(match.winner === 'guest', match.snapshot());
    }
  }
}

function runVersusGuest(dt) {
  netSendAccum += dt;
  if (netSendAccum >= NET_TICK) {
    netSendAccum = 0;
    room?.send('paddle', encodeBladePacket(getLocalVersusPaddle()));
  }
  // Smoothed toward the last packet rather than snapped to it, so a late or
  // dropped one reads as the ball carrying on instead of stuttering.
  if (guestBallActive && versusBall) {
    versusBall.mesh.position.lerp(guestBallTarget, Math.min(1, dt * 16));
    versusBall.updateVisualSpin(dt);
  }
}

// Put this player on one end of the table. Called once the room has said which
// side we are, which is not necessarily the one the player asked for.
function takeVersusSide(role) {
  netMode = role;

  // The guest plays from the far end. Turning the rig 180° also mirrors the
  // pointer mapping, so left and right stay the way round they should be with
  // no extra transforms anywhere else.
  const guest = role === 'guest';
  playerRig.position.set(0, 0, guest ? -PLAY_AREA.PLAYER_Z : PLAY_AREA.PLAYER_Z);
  playerRig.rotation.y = guest ? Math.PI : 0;

  // The board hangs beyond the far end, which for the guest is behind their
  // head. Move it to the other end and turn it round so both players read the
  // score off a board in front of them.
  scoreboard.mesh.position.z = guest ? -SCOREBOARD_POSITION.z : SCOREBOARD_POSITION.z;
  scoreboard.mesh.rotation.y = guest ? Math.PI : 0;
}

async function enterVersus(role, code, transport = 'auto', relay = null) {
  machine.enabled = false;
  coach.setActive(false);
  opponent.setActive(false);
  clearBalls();
  game.reset();

  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  netSendAccum = 0;
  match.reset();
  // Nothing serves in a match, and the launcher stands at the far end —
  // which is exactly where the guest is standing, so it would otherwise be
  // parked in their face.
  machine.mesh.visible = false;
  opponent.mesh.visible = false;

  netMode = role; // provisional, so the trainer stands down while we connect
  versusConfig = { code, role, transport, relay };
  cancelVersusReconnect();
  room = createRoom({ code, role, transport, relay });
  bindVersusRoom(room);

  await room.connect();
  takeVersusSide(room.role); // the side the room actually gave us
  game.revision++;
  return room;
}

// Everything a live match room needs to talk to the game. Kept separate from
// enterVersus so a reconnect can attach the same handlers to a fresh room
// without touching the score, the ball, or who is standing where.
function bindVersusRoom(activeRoom) {
  // Both messages are wired up before the side is known, because over the LAN
  // relay it isn't ours to decide: the server hands out host and guest by who
  // arrives first, so this client can come back as the opposite of what the
  // player pressed. Each handler checks the side it ended up on.
  activeRoom.on('paddle', (pkt) => {
    if (netMode === 'host') applyRemotePaddle(remotePaddle, pkt);
  });
  activeRoom.on('state', (state) => {
    if (netMode === 'guest') applyHostState(state);
  });

  // A dead room is not the same as an absent opponent, and the player needs
  // to know which they are looking at: one resolves itself when the other
  // player comes back, the other never does — so try to bring it back before
  // saying anything final.
  activeRoom.onClosed((reason) => {
    if (activeRoom !== room || !versusConfig) return;
    scheduleVersusReconnect(reason);
  });

  activeRoom.onOpponent((present) => {
    ui.setVersusOpponent(present);
    // The first moment both players are in the room, the host puts a ball up.
    if (
      present &&
      netMode === 'host' &&
      !match.winner &&
      !versusBall &&
      versusServeTimer <= 0
    ) {
      startVersusServe();
    }
  });
}

function cancelVersusReconnect() {
  if (versusReconnectTimer) clearTimeout(versusReconnectTimer);
  versusReconnectTimer = null;
  versusReconnectAttempts = 0;
}

// Reopen the same room code with backoff. The match state is deliberately left
// alone: a two-second Wi-Fi hiccup should not cost either player the game they
// were in the middle of, and the score on the board is the same one the
// opponent still has.
function scheduleVersusReconnect(reason) {
  if (!versusConfig || versusReconnectTimer) return;
  if (versusReconnectAttempts >= VERSUS_RECONNECT_LIMIT) {
    ui.setVersusOpponent(false);
    ui.toast(reason ? `Match ended: ${reason.toLowerCase()}` : 'Connection lost');
    ui.setVersusState('Disconnected — quit and open a new room');
    return;
  }

  versusReconnectAttempts += 1;
  const attempt = versusReconnectAttempts;
  const delay = versusReconnectDelay(attempt);
  ui.setVersusOpponent(false);
  ui.setVersusState(
    `Lost the room — reconnecting (${attempt}/${VERSUS_RECONNECT_LIMIT})…`
  );

  versusReconnectTimer = setTimeout(async () => {
    versusReconnectTimer = null;
    const config = versusConfig;
    if (!config || versusReconnectAttempts === 0) return; // left in the meantime
    const previous = room;
    let next = null;
    try {
      next = createRoom({
        code: config.code,
        role: config.role,
        transport: config.transport,
        relay: config.relay,
      });
      room = next; // the tick loop and every handler follow the live room
      bindVersusRoom(next);
      await next.connect();
      takeVersusSide(next.role);
      cancelVersusReconnect();
      // The old handle is finished with; closing it releases whichever of its
      // sockets and channels are still open, and its callbacks are ignored
      // because it is no longer `room`.
      previous?.close();
      ui.setVersusState('Reconnected — play on');
      ui.toast('Reconnected');
      game.revision++;
    } catch (error) {
      next?.close();
      if (room === next) room = previous;
      scheduleVersusReconnect(error?.message ?? reason);
    }
  }, delay);
}

function leaveVersus({ preserveTournament = false } = {}) {
  if (!netMode && !room) return;
  // Cleared before the transport closes: a deliberate exit must never look
  // like a dropped connection and start trying to reconnect into it.
  versusConfig = null;
  cancelVersusReconnect();
  room?.close();
  room = null;
  netMode = null;
  remotePaddle.enabled = false;
  remotePaddle.tracking = false;
  remotePaddle.mesh.visible = false;
  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  netSendAccum = 0;
  clearBalls();
  ui.hideCountdown();
  playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
  playerRig.rotation.y = 0;
  scoreboard.mesh.position.z = SCOREBOARD_POSITION.z;
  scoreboard.mesh.rotation.y = 0;
  applyHandedness(); // restores bat visibility the versus branch took over
  machine.mesh.visible = true;
  opponent.mesh.visible = true;
  if (!preserveTournament) clearRoomFromUrl();
  game.revision++;
}

// --- Shared tournament bracket -------------------------------------------

function tournamentLobbyView() {
  if (!tournamentLobby) return null;
  return {
    code: tournamentLobby.code,
    link: tournamentLink,
    kind: tournamentLobby.kind,
    capacity: tournamentLobby.capacity,
    players: tournamentLobby.players,
    player: tournamentLobby.player,
    isHost: tournamentLobby.isHost,
    admitted: tournamentLobby.admitted,
    spectating: tournamentLobby.spectating,
    spectatorCount: tournamentLobby.spectatorCount,
    dispute: tournamentDisputedMatch !== null,
    started: tournamentStarted,
  };
}

function updateTournamentLobbyUi() {
  const view = tournamentLobbyView();
  if (view) ui.updateTournamentLobby(view);
}

async function connectTournamentLobby(code, transport = 'auto', relay = null, { player = null } = {}) {
  if (tournamentLobby) leaveTournament();
  // A reconnect must keep the identity it already had, or the bracket sees a
  // fifth entrant and the player loses the slot they were waiting on.
  const identity = player ?? {
    id: makeTournamentPlayerId(),
    name: String(settings.get('playerName') || 'Player').trim().slice(0, 24) || 'Player',
    joinedAt: Date.now(),
  };
  const lobby = createTournamentRoom({ code, player: identity, transport, relay });
  tournamentLobby = lobby;
  tournamentConfig = { code, transport, relay, player: identity };
  tournament.localPlayerId = lobby.player.id;
  tournamentStarted = false;
  tournamentRevision = 0;
  tournamentLink = '';
  cancelTournamentReconnect();
  bindTournamentLobby(lobby);

  try {
    await lobby.connect();
    const origin = relay ? window.location.origin : lobby.lanUrls?.[0] || window.location.origin;
    tournamentLink = tournamentLinkFor(code, origin, relay);
    updateTournamentLobbyUi();
    // Everyone on the lobby asks for the bracket, spectators included — that
    // request is the entire cost of watching a tournament.
    lobby.send('state-request', { playerId: lobby.player.id });
    return tournamentLobbyView();
  } catch (error) {
    lobby.close();
    if (tournamentLobby === lobby) tournamentLobby = null;
    tournamentLink = '';
    throw error;
  }
}

function bindTournamentLobby(lobby) {
  lobby.on('state-request', () => {
    if (lobby.isHost && tournamentStarted) broadcastTournamentState();
  });
  lobby.on('state', (payload) => applyTournamentState(payload));
  lobby.on('result', (report) => acceptTournamentResult(report));
  lobby.onRoster(() => {
    updateTournamentLobbyUi();
    // A host re-announces the canonical bracket after a reconnecting player
    // joins, so a late tab never sits on a blank ladder.
    if (lobby.isHost && tournamentStarted) broadcastTournamentState();
  });
  lobby.onClosed(() => {
    if (lobby !== tournamentLobby || !tournamentConfig) return;
    scheduleTournamentReconnect();
  });
}

function cancelTournamentReconnect() {
  if (tournamentReconnectTimer) clearTimeout(tournamentReconnectTimer);
  tournamentReconnectTimer = null;
  tournamentReconnectAttempts = 0;
}

// Reopen the lobby on the same code with the same player id and backoff, so a
// dropped connection does not silently end somebody's tournament.
function scheduleTournamentReconnect() {
  if (!tournamentConfig || tournamentReconnectTimer) return;
  if (tournamentReconnectAttempts >= VERSUS_RECONNECT_LIMIT) {
    ui.showTournamentWaiting('Bracket connection lost — leave and rejoin the room.');
    return;
  }

  tournamentReconnectAttempts += 1;
  const attempt = tournamentReconnectAttempts;
  const delay = versusReconnectDelay(attempt);
  ui.showTournamentWaiting(
    `Bracket connection lost — reconnecting (${attempt}/${VERSUS_RECONNECT_LIMIT})…`
  );

  tournamentReconnectTimer = setTimeout(async () => {
    tournamentReconnectTimer = null;
    const config = tournamentConfig;
    if (!config || tournamentReconnectAttempts === 0) return;
    const previous = tournamentLobby;
    let next = null;
    try {
      next = createTournamentRoom({
        code: config.code,
        player: config.player,
        transport: config.transport,
        relay: config.relay,
      });
      // Bound before the previous handle is dropped so a failure leaves the
      // old one in place for the next attempt.
      tournamentLobby = next;
      bindTournamentLobby(next);
      await next.connect();
      cancelTournamentReconnect();
      updateTournamentLobbyUi();
      ui.toast('Reconnected to the bracket');
      next.send('state-request', { playerId: next.player.id });
      previous?.close();
    } catch (error) {
      next?.close();
      if (tournamentLobby === next) tournamentLobby = previous;
      scheduleTournamentReconnect();
    }
  }, delay);
}

function createTournamentLobby() {
  return connectTournamentLobby(makeRoomCode());
}

function joinTournamentLobby(code) {
  return connectTournamentLobby(code.trim().toUpperCase());
}

function startTournamentBracket() {
  if (!tournamentLobby?.isHost) throw new Error('Only the tournament host can start the bracket.');
  if (tournamentLobby.players.length !== TOURNAMENT_SIZE) {
    throw new Error(
      `A bracket needs ${TOURNAMENT_SIZE} joined players (${tournamentLobby.players.length} so far).`
    );
  }
  tournament.reset(tournamentLobby.players);
  tournamentStarted = true;
  tournamentRevision += 1;
  tournamentDisputedMatch = null;
  tournamentReportedMatchId = null;
  cancelTournamentResultGrace();
  broadcastTournamentState();
}

function broadcastTournamentState() {
  if (!tournamentLobby || !tournamentStarted) return;
  const payload = { revision: tournamentRevision, snapshot: tournament.snapshot() };
  applyTournamentState(payload);
  tournamentLobby.send('state', payload);
}

function applyTournamentState(payload) {
  if (!payload?.snapshot || !tournamentLobby) return false;
  const revision = Number(payload.revision);
  if (!Number.isInteger(revision) || revision < tournamentRevision) return false;
  if (!tournament.apply(payload.snapshot)) return false;
  tournamentStarted = true;
  tournamentRevision = revision;
  updateTournamentLobbyUi();
  ui.updateTournament(tournament.snapshot());
  reconcileTournamentBracket();
  return true;
}

function tournamentAssignment(bracketMatch) {
  const player = tournamentLobby?.player;
  if (!player || !bracketMatch) return null;
  const localIsFirst = bracketMatch.player1?.id === player.id;
  const opponent = localIsFirst ? bracketMatch.player2 : bracketMatch.player1;
  if (!opponent || (!localIsFirst && bracketMatch.player2?.id !== player.id)) return null;
  const suffix = bracketMatch.id === 'semi-1' ? 'A' : bracketMatch.id === 'semi-2' ? 'B' : 'F';
  return {
    id: bracketMatch.id,
    round: bracketMatch.round,
    player1: bracketMatch.player1,
    player2: bracketMatch.player2,
    opponent,
    code: `${tournamentLobby.code}-${suffix}`,
  };
}

function closeTournamentMatchRoom() {
  if (room || netMode) leaveVersus({ preserveTournament: true });
  tournamentMatch = null;
}

async function enterTournamentMatch(assignment) {
  if (!tournamentLobby?.admitted || !tournamentStarted) {
    throw new Error('The tournament bracket is not ready.');
  }
  const bracketMatch = tournament.getMatch(assignment?.id);
  const next = tournamentAssignment(bracketMatch);
  if (!next) throw new Error('This is not your active bracket match.');
  if (tournamentMatch?.id === next.id && room) return true;

  closeTournamentMatchRoom();
  // The bracket seed requests a side, but the LAN relay still owns the final
  // host/guest assignment in case both players arrive at the exact same time.
  const requestedRole = next.player1.id === tournamentLobby.player.id ? 'host' : 'guest';
  tournamentMatch = { ...next, playersByRole: null };
  // Each match gets one witness report from the guest; entering the next one
  // has to make the next one eligible.
  tournamentReportedMatchId = null;
  const activeRoom = await enterVersus(requestedRole, next.code);
  if (!tournamentLobby || tournamentMatch?.id !== next.id || activeRoom !== room) return false;

  const localRole = activeRoom.role;
  const otherRole = localRole === 'host' ? 'guest' : 'host';
  tournamentMatch.playersByRole = {
    [localRole]: tournamentLobby.player.id,
    [otherRole]: next.opponent.id,
  };
  ui.updateTournament(tournament.snapshot());
  return true;
}

function reconcileTournamentBracket() {
  if (!tournamentLobby || !tournamentStarted) return;
  // A spectator watches the same broadcast bracket and never enters a match.
  // Falling through would put them in the "waiting for your bracket result"
  // branch, which is a message about a match they are not playing in.
  if (!tournamentLobby.admitted) {
    // This runs after updateTournamentLobbyUi, so the message has to stand on
    // its own — it is what replaces the lobby status once the bracket starts.
    if (tournament.finished) {
      const champion = tournament.playerById(tournament.championId)?.name ?? 'TBD';
      ui.showTournamentWaiting(`Tournament complete — ${champion} wins.`);
    } else {
      ui.showTournamentWaiting(`Spectating room ${tournamentLobby.code}.`);
    }
    return;
  }
  const localId = tournamentLobby.player.id;
  const next = tournament.matchFor(localId);
  const currentResult = tournamentMatch && tournament.getMatch(tournamentMatch.id);
  if (currentResult?.winnerId && currentResult.id !== next?.id) closeTournamentMatchRoom();

  if (tournament.finished) {
    const champion = tournament.playerById(tournament.championId)?.name ?? 'TBD';
    ui.showTournamentWaiting(
      tournament.championId === localId ? 'Tournament champion!' : `Tournament complete — ${champion} wins.`
    );
    return;
  }

  if (!next) {
    const played = tournament.matches.find(
      (bracketMatch) =>
        bracketMatch.winnerId &&
        (bracketMatch.player1?.id === localId || bracketMatch.player2?.id === localId)
    );
    const message = played?.winnerId === localId
      ? 'You advanced — waiting for the other semifinal.'
      : played
        ? 'You are out — watch the bracket for the final.'
        : 'Waiting for the current bracket result.';
    ui.showTournamentWaiting(message);
    return;
  }

  const assignment = tournamentAssignment(next);
  if (!assignment) return;
  ui.setTournamentMatch(assignment);
  // Once a semifinal winner is known, the two finalists are already on their
  // game screens. Move them into the final automatically instead of making
  // them back out through the menu while the other players wait.
  if (ui.menu.hidden && tournamentMatch?.id !== assignment.id && !tournamentTransition) {
    tournamentTransition = true;
    enterTournamentMatch(assignment)
      .catch((error) => ui.showTournamentWaiting(error.message ?? 'Could not enter the next bracket match.'))
      .finally(() => {
        tournamentTransition = false;
      });
  }
}

// Turns the local match scoreboard into a bracket-shaped result report. The
// match room's host/guest roles have nothing to do with the bracket's
// player1/player2 order, so the mapping has to be made explicit.
function tournamentOutcome(winnerRole) {
  const context = tournamentMatch;
  if (!context?.playersByRole || !winnerRole || !tournamentLobby) return null;
  const playerOneIsHost = context.playersByRole.host === context.player1.id;
  return {
    matchId: context.id,
    winnerId: context.playersByRole[winnerRole],
    score1: playerOneIsHost ? match.scoreHost : match.scoreGuest,
    score2: playerOneIsHost ? match.scoreGuest : match.scoreHost,
    reporterId: tournamentLobby.player.id,
  };
}

function cancelTournamentResultGrace() {
  if (tournamentResultTimer) clearTimeout(tournamentResultTimer);
  tournamentResultTimer = null;
}

// A browser that dies mid-match can never send the second report, so the
// coordinator applies a lone claim once the grace period expires rather than
// stalling the bracket. The result is marked unconfirmed and the coordinator is
// told: one witness is not the same as two, and the players should know which
// kind they are looking at.
function armTournamentResultGrace(matchId) {
  cancelTournamentResultGrace();
  tournamentResultTimer = setTimeout(() => {
    tournamentResultTimer = null;
    if (!tournamentLobby?.isHost || !tournamentStarted) return;
    if (!tournament.resolveUnopposedResult(matchId)) return;
    tournamentRevision += 1;
    broadcastTournamentState();
    ui.showTournamentWaiting('Result applied — the other player never confirmed it.');
  }, TOURNAMENT_RESULT_GRACE_MS);
}

function acceptTournamentResult(report) {
  if (!tournamentLobby?.isHost || !tournamentStarted || !report) return false;
  const bracketMatch = tournament.getMatch(report.matchId);
  if (!bracketMatch) return false;
  if (
    report.reporterId !== bracketMatch.player1?.id &&
    report.reporterId !== bracketMatch.player2?.id
  ) return false;

  const outcome = tournament.recordResultReport(report);
  if (outcome.status === RESULT_STATUS.PENDING) {
    armTournamentResultGrace(report.matchId);
    return true;
  }
  cancelTournamentResultGrace();
  if (outcome.status === RESULT_STATUS.DISPUTED) {
    tournamentDisputedMatch = report.matchId;
    ui.showTournamentWaiting(
      'The two players reported different results. Open the menu and use "Use my result" to continue.'
    );
    updateTournamentLobbyUi();
    return true;
  }
  if (outcome.status === RESULT_STATUS.AGREED) {
    tournamentDisputedMatch = null;
    tournamentRevision += 1;
    broadcastTournamentState();
    return true;
  }
  return false;
}

// The tie-break has to exist: two players who will not agree would otherwise
// deadlock the bracket. The coordinator picks with their own view of the match,
// which is only meaningful if they were one of the two playing.
function overrideTournamentDispute() {
  if (!tournamentDisputedMatch || !tournamentLobby?.isHost) return;
  const bracketMatch = tournament.getMatch(tournamentDisputedMatch);
  const mine = [bracketMatch?.player1?.id, bracketMatch?.player2?.id]
    .includes(tournamentLobby.player.id);
  const applied = tournament.resolveDisputedResult(
    tournamentDisputedMatch,
    mine ? tournamentLobby.player.id : null
  );
  if (!applied) return;
  tournamentDisputedMatch = null;
  cancelTournamentResultGrace();
  updateTournamentLobbyUi();
  tournamentRevision += 1;
  broadcastTournamentState();
}

function submitTournamentResult(report) {
  if (!tournamentLobby) return;
  if (tournamentLobby.isHost) acceptTournamentResult(report);
  else tournamentLobby.send('result', report);
}

function completeTournamentMatch(winnerRole) {
  const outcome = tournamentOutcome(winnerRole);
  if (outcome) submitTournamentResult(outcome);
}

// The guest is not blind. It applied every state broadcast the host made during
// the match, so its own scoreboard is a record of what the host already said in
// public. Sending it lets the coordinator catch a host that reports something
// different at the end than it broadcast on the way there. Sent once — later
// state packets would otherwise re-report every frame.
function reportTournamentOutcomeFromGuest() {
  if (!tournamentMatch || !tournamentLobby?.admitted) return;
  if (tournamentReportedMatchId === tournamentMatch.id) return;
  const outcome = tournamentOutcome(match.winner);
  if (!outcome) return;
  tournamentReportedMatchId = tournamentMatch.id;
  submitTournamentResult(outcome);
}

function leaveTournament() {
  closeTournamentMatchRoom();
  tournamentConfig = null;
  cancelTournamentReconnect();
  cancelTournamentResultGrace();
  tournamentLobby?.close();
  tournamentLobby = null;
  tournamentStarted = false;
  tournamentMatch = null;
  tournamentTransition = false;
  tournamentReportedMatchId = null;
  tournamentDisputedMatch = null;
  tournamentLink = '';
  tournamentRevision = 0;
  tournament.localPlayerId = null;
  clearTournamentFromUrl();
}

// The board reads the match straight off these, so it can show a score
// without knowing anything about the network.
scoreboard.versus = { match, get role() { return netMode; } };

// In-headset pause menu. The DOM shell is invisible in an immersive session,
// so this is the only way to reach settings with the headset on.
const vrMenu = new VRMenu({
  camera,
  machine,
  game,
  settings,
  sfx,
  onRecenter: () => recenter(),
  onExit: () => {
    xr.end();
    machine.enabled = false;
    ui.showMenu();
  },
});
// Added to the scene, not the player rig: the panel is positioned from the
// camera's *world* pose, so parenting it under the rig would offset it by the
// rig's own position.
scene.add(vrMenu.group);

// A/X on either controller opens and closes it. There's no WebXR event for
// face buttons, so the gamepad has to be polled with edge detection.
const MENU_BUTTONS = [4, 5]; // A/X and B/Y
const STICK_BUTTON = 3; // thumbstick click
let menuButtonWasDown = false;
let stickButtonWasDown = false;

function pollMenuButton(dt) {
  const down = inputSources.some((source) =>
    MENU_BUTTONS.some((b) => source?.gamepad?.buttons?.[b]?.pressed)
  );
  if (down && !menuButtonWasDown) vrMenu.toggle();
  menuButtonWasDown = down;

  // There is no keyboard in a headset, so the one command frequent enough
  // to deserve its own button — pause/resume the machine, Space on a
  // keyboard — lives on the thumbstick click. Everything rarer is a row in
  // the in-world menu, which the face buttons open.
  const stickDown = inputSources.some(
    (source) => source?.gamepad?.buttons?.[STICK_BUTTON]?.pressed
  );
  if (stickDown && !stickButtonWasDown && !vrMenu.open && renderer.xr.isPresenting) {
    machine.enabled = !machine.enabled;
    sfx.ui(machine.enabled);
    game.revision++; // the scoreboard shows ARMED/PAUSED, so repaint it
  }
  stickButtonWasDown = stickDown;

  if (!vrMenu.open) return;

  // Thumbstick drives the menu too, so reaching a setting never depends on
  // getting a ray onto the panel. Take whichever stick is pushed furthest.
  let x = 0;
  let y = 0;
  for (const source of inputSources) {
    const axes = source?.gamepad?.axes;
    if (!axes) continue;
    // Quest reports the stick on axes 2 and 3; some runtimes use 0 and 1.
    const sx = Math.abs(axes[2] ?? 0) > Math.abs(axes[0] ?? 0) ? axes[2] : axes[0];
    const sy = Math.abs(axes[3] ?? 0) > Math.abs(axes[1] ?? 0) ? axes[3] : axes[1];
    if (Math.abs(sx ?? 0) > Math.abs(x)) x = sx ?? 0;
    if (Math.abs(sy ?? 0) > Math.abs(y)) y = sy ?? 0;
  }
  vrMenu.handleStick(x, y, dt);
}

// You hold one bat, not two. The off hand keeps its controller model so you
// can still see where it is, but carries no paddle — otherwise it swats balls
// out of the air by accident.
function applyHandedness() {
  const preferred = settings.get('hand');
  paddles.forEach((paddle, i) => {
    // The desktop bat rides the pointer, not a hand, so handedness has nothing
    // to say about it. updateDesktopBat owns whether it is live.
    if (paddle === desktopPaddle) return;
    const handedness = inputSources[i]?.handedness;
    // Before a controller reports its handedness, assume index 0 is the
    // right hand rather than leaving the player with no paddle at all.
    const hand = handedness ?? (i === 0 ? 'right' : 'left');
    const holdsPaddle = preferred === 'both' || hand === preferred;

    // Recorded as well as applied, because updateDesktopBat re-derives
    // `enabled` every frame and needs to know what handedness decided.
    paddle.handHolds = holdsPaddle;
    paddle.enabled = holdsPaddle;
    paddle.mesh.visible = holdsPaddle;
    if (controllerModels[i]) controllerModels[i].visible = !holdsPaddle;
  });
}

function applyScenario() {
  const index = SCENARIOS.findIndex((s) => s.id === settings.get('scenario'));
  // Clear first: the previous scenario's ball is held at *its* contact
  // point, which is somewhere else entirely, so switching left it hanging
  // over the table while a second one appeared at the new spot.
  clearBalls();
  coach.setScenario(index < 0 ? 0 : index);
  game.revision++;
  if (ui.menu.hidden && settings.get('game') === 'coach') {
    ui.showCoachReady(`Coach · ${coach.scenario.name}`);
  }
}

// Coach is a separate game, so the machine and the rally opponent stand
// down for it rather than it being one more drill in the rotation.
function applyGame() {
  const coaching = settings.get('game') === 'coach';
  const tournamentMode = settings.get('game') === 'tournament';
  machine.coachActive = coaching;
  // Clear on every switch, not just into Coach. A held ball never falls and
  // never recycles, so leaving one behind parked it in mid-air over the
  // arcade table for good and cost a slot in the pool.
  clearBalls();
  game.reset();
  coach.reset();
  if (tournamentMode) {
    const rallyIndex = MODES.findIndex((entry) => entry.type === 'rally');
    if (rallyIndex >= 0) machine.modeIndex = rallyIndex;
    if (tournamentStarted && ui.menu.hidden) ui.updateTournament(tournament.snapshot());
  } else if (ui.tournamentHud) {
    ui.tournamentHud.hidden = true;
  }
  game.revision++;
}

settings.onChange((key) => {
  if (key === 'paddleSource') {
    // Hold the camera open only while it is the chosen input. Nobody wants a
    // webcam light on because they tried a menu option once.
    syncCameraInput();
    syncDesktopCursor();
  }
  if (key === 'hand') applyHandedness();
  if (key === 'difficulty') {
    opponent.setSkill(settings.get('difficulty'));
    if (ui.menu.hidden && settings.get('difficulty') === 'fly') flyBrainViz.show();
    else flyBrainViz.hide();
  }
  if (key === 'scenario') applyScenario();
  if (key === 'game') applyGame();
});

applyHandedness();
opponent.setSkill(settings.get('difficulty'));
applyScenario();
applyGame();

// Guidance buzz while tracing a lesson, on whichever hand holds the bat.
function hapticGuide(strength) {
  const index = paddles.findIndex((p) => p.enabled);
  const actuator =
    inputSources[index < 0 ? 0 : index]?.gamepad?.hapticActuators?.[0];
  actuator?.pulse?.(Math.min(strength, 1) * 0.55, 45);
}

// Short haptic tap on contact, on whichever hand actually struck the ball.
function pulse(ball) {
  phonePair.haptic();
  let nearest = -1;
  let best = Infinity;
  paddles.forEach((paddle, i) => {
    const d = paddle.bladeCenter.distanceToSquared(ball.mesh.position);
    if (d < best) {
      best = d;
      nearest = i;
    }
  });
  const actuator = inputSources[nearest]?.gamepad?.hapticActuators?.[0];
  actuator?.pulse?.(0.7, 40);
}

// --- Desktop camera ---------------------------------------------------------
// The camera rides with the bat instead of being flown around independently.
//
// A free orbit camera is fine for looking at a scene and hopeless for playing
// in one: judging where a ball is in depth depends on knowing where you are,
// and if the viewpoint drifts you are re-learning that every rally. Anchoring
// it to the bat means the bat is always in the same part of the frame, the
// ball grows straight toward you, and the only thing you have to read is the
// ball's flight.
//
// It follows at a fraction of the bat's travel, not one to one. Matching the
// bat exactly makes the world swing about whenever you move, which is both
// unreadable and slightly sickening; trailing it keeps the horizon steady
// while still turning the view toward the side you are playing from.
const CAM_FOLLOW_X = 0.2; // how much of the bat's sideways travel to take
// Eye height is fixed, and deliberately so. The cursor is un-projected through
// this camera onto the plane the bat plays in, so anything the camera does in
// response to the bat feeds straight back into where the bat goes. Following
// the bat vertically put the blade a steady 13 cm above the ball — the loop
// never settled, and every ball passed just underneath. Sideways following is
// gentler (the lateral error stayed inside the blade) and worth keeping for
// the sense of playing from where you stand.
const CAM_FOLLOW_Y = 0;
const CAM_BEHIND = 0.85; // metres behind the blade
const CAM_HEIGHT = 1.5; // eye height above the floor, near enough standing
const CAM_EASE = 6; // per second; enough to feel attached, not glued

const _camAim = new THREE.Vector3();
const _camLook = new THREE.Vector3();
// The camera's own, slower copy of the aim. The position lerp smoothed where
// the camera sat, but lookAt() re-aimed it from the raw bat every frame — so
// each millimetre of tracker noise rotated the entire view, which reads as
// the whole screen shaking even when the bat's wobble is too small to see.
// The camera now follows this filtered aim for position and look alike; the
// bat itself stays on the responsive value.
const camFollow = new THREE.Vector3(0, 0.95, DESKTOP_REST_Z);
// (webcam mode reads this from the tuning panel instead)
const CAM_AIM_EASE = 3.5; // per second — deliberately lazier than the bat

function updateDesktopCamera(dt) {
  if (renderer.xr.isPresenting) return; // the headset owns the camera

  const camEase = usingWebcamBat() ? webcamTuning.camEase : CAM_AIM_EASE;
  camFollow.lerp(desktopAim, Math.min(1, dt * camEase));

  // Everything here is in rig space, so the guest's flipped rig turns the
  // view around with it and nothing else has to know.
  _camAim.set(
    camFollow.x * CAM_FOLLOW_X,
    CAM_HEIGHT + (camFollow.y - 0.95) * CAM_FOLLOW_Y,
    camFollow.z + CAM_BEHIND
  );
  camera.position.lerp(_camAim, Math.min(1, dt * CAM_EASE));

  // Look down the table, biased toward the side the bat is on, so moving wide
  // opens up the angle you are actually playing into.
  _camLook.set(camFollow.x * 0.45, TABLE.HEIGHT + 0.12, -TABLE.LENGTH * 0.42);
  playerRig.localToWorld(_camLook);
  camera.lookAt(_camLook);
}

// --- Main loop --------------------------------------------------------------
const clock = new THREE.Clock();
let servedSeen = 0;
const activePaddles = [];
const versusPaddles = [];
const ZERO = new THREE.Vector3();
let lastCoachLine = '';

function tick(dt) {
  // Choose what drives each bat before reading its pose, so the velocity
  // Paddle derives is measured against the parent it is actually on.
  const wanted = settings.get('paddleSource') ?? PADDLE_SOURCE.CONTROLLER;
  for (const source of paddleSources) {
    source.setMode(wanted);
    source.update(dt);
  }
  // A controller model is shown only for a hand that is idle: not holding
  // the bat, and not being tracked as a hand. Seeing a floating controller
  // beside your real hand is worse than seeing nothing.
  paddleSources.forEach((source, i) => {
    const model = controllerModels[i];
    if (!model) return;
    model.visible =
      !paddles[i].enabled && source.activeSource !== PADDLE_SOURCE.HAND;
  });

  // Pose the desktop bat before the paddles sample themselves, so the swing
  // velocity is measured against the pose it actually has this frame.
  // Camera first: the cursor is resolved against it, so aiming with last
  // frame's view leaves the blade trailing wherever the view was moving.
  updateDesktopCamera(dt);
  updateDesktopBat(dt);

  for (const paddle of paddles) {
    if (paddle !== desktopPaddle || !handSession) paddle.update(dt);
  }

  // A networked match replaces the trainer wholesale: no machine, no rally
  // opponent, no coach, and only one side steps physics. Bail out here rather
  // than threading `netMode` through every stage below.
  if (netMode) {
    pollMenuButton(dt);
    vrMenu.update(dt, controllers);
    for (const controller of controllers) {
      if (controller.userData.ray) controller.userData.ray.visible = vrMenu.open;
    }
    targetRing.visible = false;
    targetZone.visible = false;

    // A browser with no headset has bats that are attached to nothing, parked
    // at the rig origin. Facing down the table they sit behind the camera and
    // nobody notices; the guest's rig is turned around, which swings them into
    // view as two objects floating in front of your face. Hide what isn't
    // actually being tracked.
    for (const paddle of paddles) {
      paddle.mesh.visible = paddle.enabled && paddle.tracking;
    }

    if (netMode === 'host') runVersusHost(dt);
    else runVersusGuest(dt);

    scoreboard.update();
    ui.update();
    renderer.render(scene, camera);
    return;
  }

  // The opponent only exists in rally mode. It moves before the physics
  // step so the bat's derived velocity matches the motion this frame.
  opponent.setActive(machine.isRallyMode && !vrMenu.open);
  opponent.update(dt, balls);
  if (opponent.active && settings.get('difficulty') === 'fly') flyBrainViz.render();

  coach.setActive(machine.isCoachMode && !vrMenu.open);
  const guide = coach.update(
    dt,
    paddles.find((p) => p.enabled) ?? paddles[0],
    // Park a ball, held still, where the stroke should meet it.
    (position, spin) => {
      const ball = balls.find((b) => !b.active);
      if (!ball) return;
      ball.serve(position, ZERO, spin);
      ball.frozen = true;
    },
    () => balls.find((b) => b.active && b.frozen) ?? null,
    // Serve a live ball for the reaction drills, returned so the coach can
    // follow what happens to it.
    (position, velocity, spin) => {
      const ball = balls.find((b) => !b.active);
      if (!ball) return null;
      ball.serve(position, velocity, spin);
      return ball;
    }
  );

  if (guide > 0.08) hapticGuide(guide);

  pollMenuButton(dt);
  vrMenu.update(dt, controllers);
  for (const controller of controllers) {
    if (controller.userData.ray) controller.userData.ray.visible = vrMenu.open;
  }

  // The menu is a pause screen: hold the machine while it's up, but keep
  // stepping physics so balls already in the air settle instead of freezing
  // mid-flight.
  const wasEnabled = machine.enabled;
  if (vrMenu.open) machine.enabled = false;

  machine.update(dt);
  if (machine.servedCount !== servedSeen) {
    servedSeen = machine.servedCount;
    game.onServe();
  }

  if (vrMenu.open) machine.enabled = wasEnabled; // restore; the pause is momentary

  // The opponent's bat joins the paddle list only while it is rallying, so
  // it cannot swat balls in the other modes.
  activePaddles.length = 0;
  activePaddles.push(...paddles);
  if (opponent.active) activePaddles.push(opponent.paddle);

  for (const ball of balls) ball.updateServeToss(dt);
  physics.step(dt, balls, activePaddles);
  game.update(balls);

  // The aim ring shows where the machine is about to land a ball; in target
  // mode there's no incoming shot to telegraph, so the pad takes over.
  const targeting = machine.isTargetMode;
  targetRing.visible = !targeting && settings.get('aimMarker');
  targetZone.visible = targeting;
  if (targeting) {
    targetZone.update(dt);
  } else {
    targetRing.position.set(machine.aim.x, TABLE.HEIGHT + 0.002, machine.aim.z);
  }

  for (const ball of balls) {
    if (!ball.active) continue;
    ball.updateVisualSpin(dt);

    // Any ball that has come to rest is out of play, wherever it settled.
    // Keying retirement off the floor alone strands balls that stop on the
    // table — which silently drains the pool until the machine can't serve.
    if (ball.restingOn && ball.retireIn === null) {
      ball.retireIn = DEAD_BALL_LINGER;
    }

    if (ball.mesh.position.length() > 14) {
      retire(ball);
    } else if (ball.retireIn !== null) {
      ball.retireIn -= dt;
      if (ball.retireIn <= 0) retire(ball);
    }
  }

  // The coach's line changes without the score changing — arming, tracing,
  // switching lesson — so the board needs to know to repaint.
  if (machine.isCoachMode) {
    const line = coach.instruction;
    if (line !== lastCoachLine) {
      lastCoachLine = line;
      game.revision++;
    }
  }

  scoreboard.update();
  ui.update();
  renderer.render(scene, camera);
}

// Per-ball scoring flags reset in Ball.serve(), so returning to the pool is
// just a deactivate.
function retire(ball) {
  ball.deactivate();
}

renderer.setAnimationLoop(() => tick(clock.getDelta()));

// Dev-only handle for driving the simulation from the console or an
// automated check. `requestAnimationFrame` is frozen in a backgrounded tab,
// so stepping `tick` by hand is the only way to measure trajectories
// reliably. Vite strips this branch from production builds.
if (import.meta.env.DEV) {
  window.__probe = {
    balls, machine, physics, game, paddles, targetZone,
    settings, ui, vrMenu, opponent, coach, scene, camera, tick,
    match, remotePaddle, desktopPaddle, desktopAim,
    get camTracker() { return camTracker; },
    set camTracker(t) { camTracker = t; }, // lets tests stand in a fake tracker
    get webcamHasLocked() { return webcamHasLocked; },
    set webcamHasLocked(v) { webcamHasLocked = v; },
    get netMode() { return netMode; },
    get room() { return room; },
  };
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Keyboard shortcuts live entirely in UI, which owns the single keydown
// listener. A second listener here meant every key fired twice: Space
// toggled the machine and immediately toggled it back, and D skipped two
// modes at once.
