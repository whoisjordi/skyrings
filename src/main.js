// Entry point: builds a level, runs the loop, drives the menus.

import * as THREE from 'three';
import { initInput, Input, setAuxInput } from './input.js';
import { initTouch } from './touch.js';
import { Save } from './save.js';
import { LEVELS, formatTime } from './levels.js';
import { createTerrain, WORLD_SIZE, airportYOf, setTerrainQuality } from './terrain.js';
import { createAirport } from './airport.js';
import { buildRoute, buildCanyonRoute, RingSet } from './rings.js';
import { applySky, createClouds, createCity } from './scenery.js';
import { createCanyon } from './canyon.js';
import { Plane, TUNE } from './plane.js';
import { ChaseCamera } from './camera.js';
import { HUD } from './hud.js';
import { Audio } from './audio.js';

// Physics runs at a fixed step so recorded times mean the same thing on a
// 60Hz laptop and a 144Hz monitor.
const STEP = 1 / 120;
const MAX_STEPS = 8;

// Warning distance has to leave enough room to turn round at boost speed:
// 320kt eats the gap to the hard limit in a couple of seconds.
const SOFT_BOUND = WORLD_SIZE * 0.46;
const HARD_BOUND = WORLD_SIZE * 0.62;
const STOPPED = 4;          // speed below which a rollout counts as stopped

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
// Touch controls feed the same axes as the keyboard, so both stay live.
const touch = initTouch();
if (touch) {
  setAuxInput(touch);
  setTerrainQuality(0.72);   // coarser mesh; phones have far less to spend
}

const canvas = $('c');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: !touch, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 1, 9000);
const chase = new ChaseCamera(camera);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

// ---------------------------------------------------------------------------
// Level lifecycle
// ---------------------------------------------------------------------------
let level = null;          // built world for the current mission
let levelIndex = 0;
let state = 'menu';        // menu | flying | paused | result
let run = null;            // per-attempt state
let menuAngle = 0;

function disposeLevel() {
  if (!level) return;
  scene.remove(level.root);
  level.root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
  level = null;
}

function loadLevel(index) {
  disposeLevel();
  levelIndex = index;
  const cfg = LEVELS[index];

  const root = new THREE.Group();
  // The canyon has to exist before the terrain, which is carved to match it,
  // and before the route, which is threaded along it.
  const canyon = createCanyon(cfg, airportYOf(cfg));
  const terrain = createTerrain(cfg, canyon);
  const airport = createAirport(cfg);
  const gates = canyon
    ? buildCanyonRoute(cfg, airport, canyon, terrain.heightAt)
    : buildRoute(cfg, airport, terrain.heightAt);
  const rings = new RingSet(cfg, gates);
  // The city is built around the route so there is always a lane to fly.
  const corridor = [airport.center, ...gates.map((g) => g.position), airport.center];
  const city = createCity(cfg, terrain.heightAt, corridor);
  const plane = new Plane(cfg.palette);

  root.add(terrain.group, airport.group, rings.group, createClouds(cfg), applySky(scene, cfg.palette), plane.object);
  if (city) root.add(city.group);
  scene.add(root);

  level = { cfg, root, terrain, airport, canyon, gates, rings, city, plane };
  HUD.setLevel(cfg.name);
  resetRun();
}

function resetRun() {
  const { plane, airport, cfg } = level;
  plane.reset(airport.start.x, airport.start.y, airport.start.z, airport.start.heading);

  // Rebuild the ring set to reset gate order and colour, reusing the gates the
  // level was built with — regenerating them here would risk drifting out of
  // sync with the corridor the city was carved around.
  level.root.remove(level.rings.group);
  level.rings.dispose();
  level.rings = new RingSet(cfg, level.gates);
  level.root.add(level.rings.group);

  run = { time: 0, outcome: null, reason: '', landed: false, bellied: false, warned: false };
  if (touch) touch.resetThrottle();
  chase.snap();
  HUD.clearBanner();
}

// ---------------------------------------------------------------------------
// Simulation step
// ---------------------------------------------------------------------------
function step(dt) {
  const { plane, airport, rings, city, terrain, cfg } = level;

  run.time += dt;

  const ctrl = {
    pitch: Input.pitch() * (Save.invertPitch ? -1 : 1),
    roll: Input.roll(),
    yaw: Input.yaw(),
    throttle: Input.throttle(),
    throttleAbs: Input.throttleAbs(),
    brake: Input.brake(),
  };

  const event = plane.update(dt, ctrl, { heightAt: terrain.heightAt, airport });

  if (rings.update(dt, plane.position)) {
    Audio.ring(rings.index);
    if (rings.done) {
      HUD.banner('All gates cleared — land on the runway', 'good', 3.5);
    } else {
      HUD.banner(`Gate ${rings.index} / ${rings.total}`, 'good', 1.2);
    }
  }

  if (event) handleEvent(event);
  if (run.outcome) return;

  // Towers are solid.
  if (city && !plane.onGround
      && city.collides(plane.position.x, plane.position.y, plane.position.z)) {
    return fail('Hit a tower');
  }

  // Straying off the map: warn, then end the run.
  const fromCentre = Math.hypot(plane.position.x, plane.position.z);
  if (fromCentre > HARD_BOUND) return fail('Left the area');
  if (fromCentre > SOFT_BOUND && !run.warned) {
    run.warned = true;
    HUD.banner('Turn back', 'warn', 3);
  } else if (fromCentre < SOFT_BOUND) {
    run.warned = false;
  }

  // A gear-up arrival ends the run once the sliding stops.
  if (run.bellied && plane.onGround && plane.speed < STOPPED) {
    return fail('Landed with the gear up');
  }

  // Rollout after a valid landing with every gate cleared.
  if (run.landed && plane.onGround && plane.speed < STOPPED) succeed();
}

function handleEvent(event) {
  const { rings, plane } = level;

  if (event.type === 'crash') return fail(event.reason);

  if (event.type === 'takeoff') {
    run.landed = false;
    HUD.banner('Airborne', '', 1.2);
    return;
  }

  if (event.type === 'belly') {
    run.bellied = true;
    HUD.banner('Gear up — sliding', 'bad', 4);
    chase.shake(1.1);
    Audio.crash();
    return;
  }

  if (event.type === 'touchdown') {
    if (rings.done) {
      run.landed = true;
      HUD.banner('Down — brake to stop', 'good', 4);
    } else {
      const left = rings.total - rings.index;
      HUD.banner(`${left} gate${left === 1 ? '' : 's'} to go`, 'warn', 2.5);
    }
    chase.shake(0.35);
  }
}

function fail(reason) {
  if (run.outcome) return;
  run.outcome = 'crash';
  run.reason = reason;
  level.plane.dead = true;
  chase.shake(1.6);
  Audio.crash();
  Audio.stopEngine();
  showResult();
}

function succeed() {
  if (run.outcome) return;
  run.outcome = 'win';
  const cfg = LEVELS[levelIndex];
  run.isBest = Save.recordTime(cfg.id, run.time);
  Save.unlockThrough(levelIndex + 1);
  Audio.fanfare();
  Audio.stopEngine();
  showResult();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (state === 'flying') {
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS && !run.outcome) {
      step(STEP);
      acc -= STEP;
      steps++;
    }
    if (acc > STEP * MAX_STEPS) acc = 0; // fell too far behind; drop the debt

    const { plane, rings, airport, cfg } = level;
    const speedRatio = plane.speed / TUNE.maxSpeed;

    chase.update(dt, plane, speedRatio, plane.nitroBlend);
    Audio.updateEngine(plane.throttle, speedRatio);

    HUD.update({
      speed: plane.speed,
      altitude: plane.position.y,
      throttle: plane.throttle,
      gearPos: plane.gearPos,
      gearDown: plane.gearDown,
      nitroActive: plane.nitroActive,
      nitroTime: plane.nitroTime,
      nitroCooldown: plane.nitroCooldown,
      time: run.time,
      rings: rings.index,
      total: rings.total,
      target: cfg.target,
      stalling: plane.stalling,
    });
    camera.updateMatrixWorld();
    HUD.updateArrow(rings.done ? airport.center : rings.next.position, camera);
    HUD.tickBanner();

    if (Input.tapped('KeyN')) {
      if (plane.fireNitro()) {
        HUD.banner('Nitro', 'bad', 1.2);
        Audio.nitro();
      } else if (plane.nitroActive) {
        HUD.banner('Nitro already burning', 'warn', 1);
      } else {
        HUD.banner(`Nitro recharging — ${Math.ceil(plane.nitroCooldown)}s`, 'warn', 1);
      }
    }
    if (Input.tapped('KeyG')) {
      if (plane.toggleGear()) {
        HUD.banner(plane.gearDown ? 'Gear down' : 'Gear up', '', 1.4);
      } else {
        HUD.banner('Gear is locked down on the ground', 'warn', 1.6);
      }
    }
    if (Input.tapped('KeyC')) chase.toggle();
    if (Input.tapped('KeyR')) resetRun();
    if (Input.tapped('Escape') || Input.tapped('KeyP')) pause();
  } else if (state === 'menu' && level) {
    // Slow orbit over the field behind the title card.
    menuAngle += dt * 0.09;
    const c = level.airport.center;
    camera.up.set(0, 1, 0);
    camera.position.set(
      c.x + Math.cos(menuAngle) * 720,
      c.y + 300,
      c.z + Math.sin(menuAngle) * 720,
    );
    camera.lookAt(c.x, c.y + 40, c.z);
    camera.fov = 60;
    camera.updateProjectionMatrix();
  }

  Input.endFrame();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
const screens = {
  title: $('screen-title'),
  levels: $('screen-levels'),
  pause: $('screen-pause'),
  result: $('screen-result'),
};

function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle('hidden', key !== name);
  }
}

function hideScreens() {
  for (const node of Object.values(screens)) node.classList.add('hidden');
}

function startLevel(index) {
  Audio.unlock();
  if (touch) touch.enable();
  if (!level || levelIndex !== index) loadLevel(index);
  else resetRun();

  state = 'flying';
  acc = 0;
  last = performance.now();
  hideScreens();
  HUD.show(true);
  Audio.startEngine();
  HUD.banner(touch ? 'Throttle up — slider on the left' : 'Throttle up — hold Shift', '', 3);
}

function pause() {
  if (state !== 'flying') return;
  state = 'paused';
  Audio.stopEngine();
  HUD.show(false);
  if (touch) touch.disable();
  $('btn-invert').textContent = Save.invertPitch ? 'ON' : 'OFF';
  refreshTouchOptions();
  showScreen('pause');
}

function refreshTouchOptions() {
  if (!touch) return;
  $('btn-mode').textContent = touch.mode === 'arrows' ? 'ARROWS' : 'STICK';
}

function resume() {
  state = 'flying';
  if (touch) touch.enable();
  last = performance.now();
  acc = 0;
  hideScreens();
  HUD.show(true);
  Audio.startEngine();
}

function toMenu() {
  state = 'menu';
  HUD.show(false);
  if (touch) touch.disable();
  Audio.stopEngine();
  buildLevelList();
  showScreen('levels');
}

function showResult() {
  state = 'result';
  HUD.show(false);
  if (touch) touch.disable();
  const cfg = LEVELS[levelIndex];
  const won = run.outcome === 'win';

  $('res-title').textContent = won ? 'Mission complete' : 'Crashed';
  $('res-sub').textContent = won
    ? `${cfg.name} — target ${formatTime(cfg.target)}`
    : run.reason;
  $('res-stats').style.display = won ? '' : 'none';
  $('res-time').textContent = formatTime(run.time);
  $('res-best').textContent = formatTime(Save.bestTime(cfg.id));
  $('res-pb').classList.toggle('hidden', !(won && run.isBest));

  const hasNext = levelIndex + 1 < LEVELS.length;
  const next = $('btn-next');
  next.disabled = !(won && hasNext);
  next.textContent = hasNext ? 'Next mission' : 'All missions flown';

  showScreen('result');
}

function buildLevelList() {
  const list = $('level-list');
  list.innerHTML = '';
  LEVELS.forEach((cfg, i) => {
    const unlocked = Save.isUnlocked(i);
    const best = Save.bestTime(cfg.id);
    const btn = document.createElement('button');
    btn.className = 'lv';
    btn.disabled = !unlocked;
    btn.innerHTML = `
      <span class="n">${i + 1}</span>
      <span>
        <span class="nm">${cfg.name}</span>
        <span class="ds">${unlocked ? cfg.blurb : 'Finish the previous mission to unlock'}</span>
      </span>
      <span class="bt ${best == null ? 'locked' : ''}">${best == null ? '—' : formatTime(best)}</span>`;
    btn.addEventListener('click', () => startLevel(i));
    list.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('btn-play').addEventListener('click', () => {
  // Pick up at the furthest mission actually reached, not the furthest
  // selectable one — otherwise the testing unlock drops you straight into the
  // hardest mission on a fresh save.
  startLevel(Math.min(LEVELS.length - 1, Math.max(0, Save.reachedCount() - 1)));
});
$('btn-levels').addEventListener('click', () => { Audio.unlock(); toMenu(); });
$('btn-back').addEventListener('click', () => { state = 'menu'; showScreen('title'); });
$('btn-resume').addEventListener('click', resume);
$('btn-restart').addEventListener('click', () => { resetRun(); resume(); });
$('btn-quit').addEventListener('click', toMenu);
$('btn-retry').addEventListener('click', () => startLevel(levelIndex));
$('btn-menu').addEventListener('click', toMenu);
$('btn-next').addEventListener('click', () => startLevel(levelIndex + 1));
$('btn-invert').addEventListener('click', (e) => {
  Save.invertPitch = !Save.invertPitch;
  e.target.textContent = Save.invertPitch ? 'ON' : 'OFF';
});

if (touch) {
  $('btn-mode').addEventListener('click', () => {
    touch.setMode(touch.mode === 'arrows' ? 'stick' : 'arrows');
    refreshTouchOptions();
  });
}

// Don't let the aeroplane fly on while the tab is hidden.
addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

initInput();
loadLevel(0);
buildLevelList();
showScreen('title');
$('loading').classList.add('hidden');
requestAnimationFrame(frame);
