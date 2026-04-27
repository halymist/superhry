// Arena client. Three.js + WebSocket. Client-authoritative movement & projectiles.
// Server only relays messages and tracks HP for consistent kills.

import * as THREE from 'three';

// ---------------- config ----------------
const MOVE_SPEED   = 8.0;   // u/s

// Q skillshot (Mystic Shot)
const Q_SPEED      = 25.0;
const Q_RANGE      = 18.0;
const Q_RADIUS     = 0.5;
const Q_DAMAGE     = 40;
const Q_COOLDOWN_MS = 1500;

// Ranged auto-attack
const AA_SPEED     = 30.0;
const AA_RANGE     = 11.0;
const AA_RADIUS    = 0.28;
const AA_DAMAGE    = 12;
const AA_COOLDOWN_MS = 600;

const PLAYER_RADIUS = 0.6;

// E blink
const E_RANGE = 7.5;
const E_COOLDOWN_MS = 7000;
const E_OUT_MS = 80;
const E_IN_MS  = 140;

const INTERP_DELAY_MS = 120; // remote interpolation
const SEND_HZ = 20;

// ---------------- DOM / modal ----------------
const nameModal = document.getElementById('name-modal');
const nameInput = document.getElementById('name-input');
const nameGo    = document.getElementById('name-go');

const hpText = document.getElementById('hp-text');
const hpFill = document.getElementById('hp-fill');
const slotQ     = document.getElementById('slot-q');
const slotQMask = document.getElementById('slot-q-mask');
const slotE     = document.getElementById('slot-e');
const slotEMask = document.getElementById('slot-e-mask');
const playerListEl = document.getElementById('player-list');
const killfeedEl = document.getElementById('killfeed');

const savedName = sessionStorage.getItem('superhry-name') || '';
nameInput.value = savedName;

let myName = '';

function startWithName() {
  const n = (nameInput.value || 'player').trim().slice(0, 16);
  myName = n || 'player';
  sessionStorage.setItem('superhry-name', myName);
  nameModal.style.display = 'none';
  startGame();
}
nameGo.addEventListener('click', startWithName);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startWithName(); });

// ---------------- three.js setup ----------------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2f57);
scene.fog = new THREE.Fog(0x1b2f57, 38, 95);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
const CAM_OFFSET = new THREE.Vector3(0, 22, 18); // fixed League-like camera offset
const CAM_LOOK_OFFSET_Z = -2.0;

// lighting
scene.add(new THREE.AmbientLight(0x8ab4ff, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(12, 22, 10);
scene.add(sun);

// ground & grid
const GROUND_HX = 25, GROUND_HZ = 15;
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_HX * 2, GROUND_HZ * 2),
  new THREE.MeshStandardMaterial({ color: 0x2e4f84, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const grid = new THREE.GridHelper(Math.max(GROUND_HX, GROUND_HZ) * 2, 30, 0x70a4ff, 0x2a466f);
grid.position.y = 0.01;
scene.add(grid);

// border walls (visual + collision)
const obstacles = []; // [{minX,maxX,minZ,maxZ}]
function registerObstacle(x, z, w, d) {
  obstacles.push({
    minX: x - w / 2, maxX: x + w / 2,
    minZ: z - d / 2, maxZ: z + d / 2,
  });
}

function addWall(w, h, d, x, z) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: 0x466aa1, roughness: 0.88 })
  );
  m.position.set(x, h / 2, z);
  scene.add(m);
  registerObstacle(x, z, w, d);
}
addWall(GROUND_HX * 2 + 1, 1.0, 0.5,  0,  GROUND_HZ + 0.25);
addWall(GROUND_HX * 2 + 1, 1.0, 0.5,  0, -GROUND_HZ - 0.25);
addWall(0.5, 1.0, GROUND_HZ * 2,  GROUND_HX + 0.25, 0);
addWall(0.5, 1.0, GROUND_HZ * 2, -GROUND_HX - 0.25, 0);

// some cover boxes
function addBox(x, z, w, d, h = 1.2, color = 0x3a4560) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
  );
  m.position.set(x, h / 2, z);
  scene.add(m);
  registerObstacle(x, z, w, d);
  return m;
}
addBox(-8, -3, 2, 2, 1.2, 0x5e7fc0);
addBox( 8,  3, 2, 2, 1.2, 0x7c62c4);
addBox( 0,  6, 4, 1, 1.2, 0x4f88cc);
addBox( 0, -6, 4, 1, 1.2, 0x4f88cc);
addBox(-14, 5, 1, 4, 1.2, 0x6a70c9);
addBox( 14,-5, 1, 4, 1.2, 0x6a70c9);

// ---------------- player meshes ----------------
function makeBody(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_RADIUS, 0.8, 4, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.08, emissive: color, emissiveIntensity: 0.12 })
  );
  body.position.y = 0.9;
  g.add(body);

  // clearer facing marker: a bright forward wedge + ring.
  const dir = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.8, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x88d8ff, emissiveIntensity: 0.55 })
  );
  dir.rotation.x = Math.PI / 2;
  dir.position.set(0, 0.95, -0.95);
  g.add(dir);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.86, 0.98, 24),
    new THREE.MeshBasicMaterial({ color: 0xb9dfff, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  g.add(ring);

  // billboard nameplate (CanvasTexture sprite)
  const sprite = makeNameSprite('');
  sprite.position.y = 2.2;
  g.add(sprite);
  g.userData.nameSprite = sprite;

  return g;
}

function makeNameSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  drawNameSprite(ctx, text, '#e6e8ee');
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.6, 0.65, 1);
  sp.userData.canvas = c;
  sp.userData.ctx = ctx;
  sp.userData.tex = tex;
  return sp;
}
function drawNameSprite(ctx, text, color) {
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 28px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(text, 128, 33);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 32);
}
function setNameSprite(sp, text, color = '#e6e8ee') {
  drawNameSprite(sp.userData.ctx, text, color);
  sp.userData.tex.needsUpdate = true;
}

// ---------------- networking ----------------
let ws = null;
let myId = 0;
let serverHalfX = GROUND_HX, serverHalfZ = GROUND_HZ;
let startHP = 100;

const players = new Map(); // id -> { mesh, name, hp, alive, snapshots: [{t,x,z,facing}], lastSeen }
const projectiles = []; // {pid, owner, x, z, vx, vz, dist, max, mesh, hitDone}

let myProjectileSeq = 1;
let qReadyAt = 0;
let eReadyAt = 0;
let aaReadyAt = 0;
let teleportMode = false;
let qMode = false;

// --- collision helpers ---
function pointInObstacle(x, z, rad) {
  for (const o of obstacles) {
    if (x > o.minX - rad && x < o.maxX + rad &&
        z > o.minZ - rad && z < o.maxZ + rad) return o;
  }
  return null;
}
function resolveMove(prevX, prevZ, newX, newZ, rad) {
  let x = prevX, z = prevZ;
  if (!pointInObstacle(newX, prevZ, rad)) x = newX;
  if (!pointInObstacle(x, newZ, rad)) z = newZ;
  return { x, z };
}
function segmentEndpoint(prevX, prevZ, dirX, dirZ, dist, rad) {
  const steps = Math.max(8, Math.ceil(dist / 0.25));
  const step = dist / steps;
  let x = prevX, z = prevZ;
  for (let i = 0; i < steps; i++) {
    const nx = x + dirX * step;
    const nz = z + dirZ * step;
    if (pointInObstacle(nx, nz, rad)) break;
    if (nx < -serverHalfX || nx > serverHalfX || nz < -serverHalfZ || nz > serverHalfZ) break;
    x = nx; z = nz;
  }
  return { x, z };
}

const aimLineMat = new THREE.LineBasicMaterial({ color: 0x80e7ff, transparent: true, opacity: 0.9 });
const aimLineGeom = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0.08, 0),
  new THREE.Vector3(0, 0.08, 0),
]);
const aimLine = new THREE.Line(aimLineGeom, aimLineMat);
aimLine.visible = false;
scene.add(aimLine);

const teleportRangeMat = new THREE.MeshBasicMaterial({ color: 0x78c3ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
const teleportRange = new THREE.Mesh(new THREE.CircleGeometry(E_RANGE, 40), teleportRangeMat);
teleportRange.rotation.x = -Math.PI / 2;
teleportRange.position.y = 0.04;
teleportRange.visible = false;
scene.add(teleportRange);

const blink = { active: false, start: 0 };

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/arena`;
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    send({ type: 'join', data: { name: myName } });
  });
  ws.addEventListener('message', ev => onMessage(ev.data));
  ws.addEventListener('close', () => {
    // simple auto-reconnect
    setTimeout(connect, 1000);
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function onMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case 'welcome':
      myId = m.data.youId;
      serverHalfX = m.data.halfX;
      serverHalfZ = m.data.halfZ;
      startHP = m.data.startHp;
      break;

    case 'snap':
      handleSnapshot(m.data);
      break;

    case 'fire':
      // ignore our own fire echo (we already spawned it locally)
      if (m.data.owner === myId) break;
      spawnProjectile(m.data);
      break;

    case 'hit':
      handleHit(m.data);
      break;

    case 'leave':
      removePlayer(m.data.id);
      break;
  }
}

function handleSnapshot(snap) {
  const seenIds = new Set();
  for (const p of snap.players) {
    seenIds.add(p.id);
    let pl = players.get(p.id);
    if (!pl) {
      const color = p.id === myId ? 0x6cf : pickColor(p.id);
      const mesh = makeBody(color);
      scene.add(mesh);
      pl = { mesh, name: p.name, hp: p.hp, alive: p.alive, snapshots: [], color };
      players.set(p.id, pl);
      setNameSprite(mesh.userData.nameSprite, p.name, p.id === myId ? '#6cf' : '#e6e8ee');
    }
    if (pl.name !== p.name) {
      pl.name = p.name;
      setNameSprite(pl.mesh.userData.nameSprite, p.name, p.id === myId ? '#6cf' : '#e6e8ee');
    }
    pl.hp = p.hp;
    pl.alive = p.alive;
    if (p.id !== myId) {
      pl.snapshots.push({ t: snap.t, x: p.x, z: p.z, facing: p.facing });
      // trim to last 1s
      const cutoff = snap.t - 1000;
      while (pl.snapshots.length > 2 && pl.snapshots[0].t < cutoff) pl.snapshots.shift();
    }
    // visibility on death
    pl.mesh.visible = p.alive;
    // server-driven (re)spawn position for me: snap on dead→alive transition,
    // and on first ever snapshot
    if (p.id === myId) {
      if (pl._initSync !== true || (pl._wasAlive === false && p.alive)) {
        myPos.x = p.x; myPos.z = p.z;
        pl._initSync = true;
      }
      pl._wasAlive = p.alive;
    }
  }
  // any local player not in snapshot → remove
  for (const id of [...players.keys()]) {
    if (!seenIds.has(id)) removePlayer(id);
  }
  // update my HP from snapshot
  const me = players.get(myId);
  if (me) {
    hpText.textContent = `${me.hp}/${startHP}`;
    hpFill.style.width = `${Math.max(0, me.hp) / startHP * 100}%`;
  }
  refreshPlayerList();
}

function removePlayer(id) {
  const pl = players.get(id);
  if (!pl) return;
  scene.remove(pl.mesh);
  pl.mesh.userData.nameSprite.userData.tex.dispose();
  pl.mesh.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material.dispose();
    }
  });
  players.delete(id);
  refreshPlayerList();
}

function refreshPlayerList() {
  const rows = [];
  const sorted = [...players.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sorted) {
    const dead = p.alive ? '' : ' <span class="muted">(dead)</span>';
    rows.push(`<div class="row"><span>${escapeHtml(p.name)}</span><span class="muted">${p.hp}${dead}</span></div>`);
  }
  playerListEl.innerHTML = rows.join('');
}

function pushKillfeed(html) {
  const div = document.createElement('div');
  div.className = 'kf-row';
  div.innerHTML = html;
  killfeedEl.prepend(div);
  while (killfeedEl.children.length > 6) killfeedEl.removeChild(killfeedEl.lastChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function pickColor(id) {
  const palette = [0xe88, 0x8e8, 0xee8, 0xe8e, 0x8ee, 0xfa6, 0xf68, 0x68f];
  return palette[id % palette.length];
}

// ---------------- input ----------------
window.addEventListener('keydown', e => {
  if (nameModal.style.display !== 'none') return;
  if (e.code === 'KeyQ' || e.code === 'Space') {
    e.preventDefault();
    tryEnterQMode();
  } else if (e.code === 'KeyE') {
    e.preventDefault();
    tryEnterTeleportMode();
  }
});

const mouseWorld = new THREE.Vector3(); // intersection with ground
const mouseNDC = new THREE.Vector2();
let hasMouse = false;
let rightMouseDown = false;
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouseNDC.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  hasMouse = true;
  if (rightMouseDown) {
    updateMouseWorld();
    setMoveTarget(mouseWorld.x, mouseWorld.z);
  }
});
canvas.addEventListener('mousedown', e => {
  if (e.button === 0) {
    if (teleportMode) {
      tryTeleport();
    } else if (qMode) {
      tryFireQ();
    } else {
      tryAutoAttack();
    }
  } else if (e.button === 2) {
    if (teleportMode) { teleportMode = false; slotE.classList.remove('targeting'); }
    if (qMode)        { qMode = false;        slotQ.classList.remove('targeting'); }
    rightMouseDown = true;
    updateMouseWorld();
    setMoveTarget(mouseWorld.x, mouseWorld.z);
  }
});
canvas.addEventListener('mouseup', e => {
  if (e.button === 2) rightMouseDown = false;
});
window.addEventListener('blur', () => {
  rightMouseDown = false;
});
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
});

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function updateMouseWorld() {
  if (!hasMouse) return;
  raycaster.setFromCamera(mouseNDC, camera);
  raycaster.ray.intersectPlane(groundPlane, mouseWorld);
}

// ---------------- local player state ----------------
const myPos = new THREE.Vector3(0, 0, 0);
let myFacing = 0;
const moveTarget = new THREE.Vector2();
let hasMoveTarget = false;

function setMoveTarget(x, z) {
  moveTarget.x = Math.max(-serverHalfX, Math.min(serverHalfX, x));
  moveTarget.y = Math.max(-serverHalfZ, Math.min(serverHalfZ, z));
  hasMoveTarget = true;
}

function setupSpawn() {
  myPos.x = (Math.random() * 2 - 1) * (serverHalfX - 2);
  myPos.z = (Math.random() * 2 - 1) * (serverHalfZ - 2);
  hasMoveTarget = false;
  teleportMode = false;
  qMode = false;
  blink.active = false;
  slotE.classList.remove('targeting');
  slotQ.classList.remove('targeting');
}

function tryEnterQMode() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (performance.now() < qReadyAt) return;
  qMode = true;
  slotQ.classList.add('targeting');
  if (teleportMode) { teleportMode = false; slotE.classList.remove('targeting'); }
}

function tryEnterTeleportMode() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (performance.now() < eReadyAt) return;
  teleportMode = true;
  slotE.classList.add('targeting');
  if (qMode) { qMode = false; slotQ.classList.remove('targeting'); }
}

function tryTeleport() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < eReadyAt) return;

  const dx = mouseWorld.x - myPos.x;
  const dz = mouseWorld.z - myPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) return;

  const ux = dx / dist, uz = dz / dist;
  const want = Math.min(E_RANGE, dist);
  const dest = segmentEndpoint(myPos.x, myPos.z, ux, uz, want, PLAYER_RADIUS);

  // Bail if blocked immediately
  if (Math.hypot(dest.x - myPos.x, dest.z - myPos.z) < 0.1) return;

  myPos.x = Math.max(-serverHalfX, Math.min(serverHalfX, dest.x));
  myPos.z = Math.max(-serverHalfZ, Math.min(serverHalfZ, dest.z));
  hasMoveTarget = false;

  eReadyAt = now + E_COOLDOWN_MS;
  teleportMode = false;
  slotE.classList.remove('targeting');

  blink.active = true;
  blink.start = now;

  // Push immediate state so others see the blink quickly.
  send({ type: 'state', data: { x: myPos.x, z: myPos.z, facing: myFacing } });
}

// ---------------- projectiles ----------------
function tryFireQ() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < qReadyAt) return;
  qReadyAt = now + Q_COOLDOWN_MS;
  qMode = false;
  slotQ.classList.remove('targeting');
  fireProjectile('q');
}

function tryAutoAttack() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < aaReadyAt) return;
  aaReadyAt = now + AA_COOLDOWN_MS;
  fireProjectile('aa');
}

function fireProjectile(kind) {
  let dx = mouseWorld.x - myPos.x;
  let dz = mouseWorld.z - myPos.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.001) {
    dx = Math.sin(myFacing); dz = Math.cos(myFacing);
  } else {
    dx /= len; dz /= len;
  }
  const pid = myProjectileSeq++;
  const ox = myPos.x + dx * (PLAYER_RADIUS + 0.3);
  const oz = myPos.z + dz * (PLAYER_RADIUS + 0.3);
  spawnProjectile({ owner: myId, pid, ox, oz, dx, dz, kind });
  send({ type: 'fire', data: { pid, ox, oz, dx, dz, kind } });
}

function spawnProjectile(p) {
  const kind = p.kind || 'q';
  const isQ = kind === 'q';
  const radius = isQ ? Q_RADIUS : AA_RADIUS;
  const speed  = isQ ? Q_SPEED  : AA_SPEED;
  const range  = isQ ? Q_RANGE  : AA_RANGE;
  const dmg    = isQ ? Q_DAMAGE : AA_DAMAGE;
  const color  = isQ
    ? (p.owner === myId ? 0xffe48a : 0xff9b66)
    : (p.owner === myId ? 0xa6f0ff : 0xfff0a0);

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 18, 14),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.85 })
  );
  mesh.position.set(p.ox, 1.0, p.oz);
  scene.add(mesh);

  const light = new THREE.PointLight(color, isQ ? 1.0 : 0.5, isQ ? 5 : 3);
  mesh.add(light);

  projectiles.push({
    pid: p.pid,
    owner: p.owner,
    x: p.ox, z: p.oz,
    vx: p.dx * speed, vz: p.dz * speed,
    radius, range, dmg, isQ,
    dist: 0,
    mesh,
    hitDone: false,
  });
}

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    const stepX = pr.vx * dt;
    const stepZ = pr.vz * dt;
    pr.x += stepX;
    pr.z += stepZ;
    pr.dist += Math.hypot(stepX, stepZ);
    pr.mesh.position.x = pr.x;
    pr.mesh.position.z = pr.z;

    // wall collision
    if (pointInObstacle(pr.x, pr.z, pr.radius)) {
      disposeProjectile(i);
      continue;
    }

    // shooter checks hits (client-authoritative)
    if (pr.owner === myId && !pr.hitDone) {
      for (const [pid, pl] of players) {
        if (pid === myId || !pl.alive) continue;
        const tx = pl.mesh.position.x;
        const tz = pl.mesh.position.z;
        const dx = tx - pr.x, dz = tz - pr.z;
        if (dx * dx + dz * dz <= (pr.radius + PLAYER_RADIUS) ** 2) {
          pr.hitDone = true;
          send({ type: 'hit', data: { pid: pr.pid, target: pid, dmg: pr.dmg } });
          disposeProjectile(i);
          break;
        }
      }
    }

    // expire on range or wall
    if (pr.dist > pr.range ||
        Math.abs(pr.x) > serverHalfX + 1 ||
        Math.abs(pr.z) > serverHalfZ + 1) {
      disposeProjectile(i);
    }
  }
}

function disposeProjectile(i) {
  const pr = projectiles[i];
  if (!pr) return;
  scene.remove(pr.mesh);
  pr.mesh.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material.dispose();
    }
  });
  projectiles.splice(i, 1);
}

// ---------------- hit display ----------------
function handleHit(d) {
  // d: { shooter, target, pid, hp, killed, t }
  const sh = players.get(d.shooter);
  const tg = players.get(d.target);
  const sName = sh ? sh.name : `p${d.shooter}`;
  const tName = tg ? tg.name : `p${d.target}`;
  if (d.killed) {
    pushKillfeed(`<span class="kf-kill"><b>${escapeHtml(sName)}</b> ✕ <b class="victim">${escapeHtml(tName)}</b></span>`);
  } else {
    pushKillfeed(`<span class="muted">${escapeHtml(sName)} hit ${escapeHtml(tName)} (-${startHP - d.hp >= 0 ? (startHP - d.hp) : 0} → ${d.hp})</span>`);
  }
  if (tg) {
    tg.hp = d.hp;
    if (d.killed) tg.alive = false;
  }
  refreshPlayerList();
}

// ---------------- main loop ----------------
let lastT = 0;
let lastSendT = 0;

function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;

  updateMouseWorld();

  const me = players.get(myId);
  const alive = me ? me.alive : true;

  // local movement: right-click to move (with wall collision)
  if (alive) {
    if (hasMoveTarget) {
      const dx = moveTarget.x - myPos.x;
      const dz = moveTarget.y - myPos.z;
      const dist = Math.hypot(dx, dz);
      let nx, nz;
      if (dist <= MOVE_SPEED * dt || dist < 0.08) {
        nx = moveTarget.x; nz = moveTarget.y;
      } else {
        nx = myPos.x + (dx / dist) * MOVE_SPEED * dt;
        nz = myPos.z + (dz / dist) * MOVE_SPEED * dt;
      }
      const res = resolveMove(myPos.x, myPos.z, nx, nz, PLAYER_RADIUS);
      const moved = Math.hypot(res.x - myPos.x, res.z - myPos.z);
      myPos.x = res.x; myPos.z = res.z;
      myPos.x = Math.max(-serverHalfX, Math.min(serverHalfX, myPos.x));
      myPos.z = Math.max(-serverHalfZ, Math.min(serverHalfZ, myPos.z));
      if (dist <= MOVE_SPEED * dt || dist < 0.08 || moved < 0.0005) {
        hasMoveTarget = false;
      }
    }

    // facing toward mouse
    if (hasMouse) {
      const dx = mouseWorld.x - myPos.x;
      const dz = mouseWorld.z - myPos.z;
      if (dx * dx + dz * dz > 0.01) myFacing = Math.atan2(dx, dz);
    }
  } else {
    // dead → cancel any pending modes
    qMode = false;
    teleportMode = false;
    hasMoveTarget = false;
    slotQ.classList.remove('targeting');
    slotE.classList.remove('targeting');
  }

  // place my mesh + apply blink scale animation
  if (me) {
    me.mesh.position.x = myPos.x;
    me.mesh.position.z = myPos.z;
    me.mesh.rotation.y = myFacing;

    let s = 1;
    if (blink.active) {
      const dtMs = performance.now() - blink.start;
      const total = E_OUT_MS + E_IN_MS;
      if (dtMs >= total) { blink.active = false; s = 1; }
      else if (dtMs < E_OUT_MS) s = 1 - dtMs / E_OUT_MS;
      else s = (dtMs - E_OUT_MS) / E_IN_MS;
    }
    me.mesh.scale.setScalar(Math.max(0.05, s));
  }

  // interpolate remote players
  const renderT = Date.now() - INTERP_DELAY_MS;
  for (const [id, pl] of players) {
    if (id === myId) continue;
    const buf = pl.snapshots;
    if (buf.length === 0) continue;
    if (buf.length === 1 || renderT <= buf[0].t) {
      const s = buf[0];
      pl.mesh.position.x = s.x;
      pl.mesh.position.z = s.z;
      pl.mesh.rotation.y = s.facing;
      continue;
    }
    // find pair
    let a = buf[0], b = buf[1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderT && buf[i+1].t >= renderT) { a = buf[i]; b = buf[i+1]; break; }
      a = buf[i]; b = buf[i+1];
    }
    const span = Math.max(1, b.t - a.t);
    const k = Math.max(0, Math.min(1, (renderT - a.t) / span));
    pl.mesh.position.x = a.x + (b.x - a.x) * k;
    pl.mesh.position.z = a.z + (b.z - a.z) * k;
    // shortest-arc angle lerp
    let da = b.facing - a.facing;
    while (da >  Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    pl.mesh.rotation.y = a.facing + da * k;
  }

  // projectiles
  updateProjectiles(dt);

  // skillshot / autoattack aim indicator
  if (alive && hasMouse && !teleportMode) {
    const dx = mouseWorld.x - myPos.x;
    const dz = mouseWorld.z - myPos.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.001) {
      const ux = dx / len;
      const uz = dz / len;
      const reach = qMode ? Q_RANGE : AA_RANGE;
      const start = new THREE.Vector3(myPos.x + ux * (PLAYER_RADIUS + 0.2), 0.08, myPos.z + uz * (PLAYER_RADIUS + 0.2));
      const end = new THREE.Vector3(start.x + ux * reach, 0.08, start.z + uz * reach);
      aimLine.geometry.setFromPoints([start, end]);
      aimLineMat.color.setHex(qMode ? 0xffe27a : 0x80e7ff);
      aimLineMat.opacity = qMode ? 0.95 : 0.45;
      aimLine.visible = true;
    } else {
      aimLine.visible = false;
    }
  } else {
    aimLine.visible = false;
  }

  teleportRange.visible = teleportMode && alive;
  if (teleportRange.visible) {
    teleportRange.position.x = myPos.x;
    teleportRange.position.z = myPos.z;
  }

  // camera follow: fixed world orientation, champion-centered
  const target = me ? me.mesh.position : new THREE.Vector3();
  camera.position.set(target.x + CAM_OFFSET.x, CAM_OFFSET.y, target.z + CAM_OFFSET.z);
  camera.lookAt(target.x, 0.0, target.z + CAM_LOOK_OFFSET_Z);
  camera.up.set(0, 1, 0);

  // cooldown HUD
  const now = performance.now();
  const qRemain = Math.max(0, qReadyAt - now);
  const qCooldownRatio = Math.max(0, Math.min(1, qRemain / Q_COOLDOWN_MS));
  slotQMask.style.transform = `scaleY(${qCooldownRatio})`;

  const eRemain = Math.max(0, eReadyAt - now);
  const eCooldownRatio = Math.max(0, Math.min(1, eRemain / E_COOLDOWN_MS));
  slotEMask.style.transform = `scaleY(${eCooldownRatio})`;

  // periodic state send
  if (t - lastSendT > 1000 / SEND_HZ) {
    lastSendT = t;
    if (alive && myId) {
      send({ type: 'state', data: { x: myPos.x, z: myPos.z, facing: myFacing } });
    }
  }

  renderer.render(scene, camera);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function startGame() {
  resize();
  setupSpawn();
  connect();
  requestAnimationFrame(t => { lastT = t; loop(t); });
}
