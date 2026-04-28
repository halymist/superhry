// Arena client. Three.js + WebSocket. Client-authoritative movement & projectiles.
// Server only relays messages and tracks HP for consistent kills.

import * as THREE from 'three';

// ---------------- config ----------------
const MOVE_SPEED   = 7.2;   // u/s

// Q skillshot (Mystic Shot)
const Q_SPEED_START = 19.0;
const Q_SPEED_MAX   = 19.0;
const Q_ACCEL       = 0.0;
const Q_RANGE      = 16.0;
const Q_RADIUS     = 0.24;
const Q_DAMAGE     = 10;
const Q_COOLDOWN_MS = 1800;
const Q_COST       = 35;
const Q_BURST_MS = 2400;
const Q_BURST_INTERVAL_MS = 130;

// Ranged auto-attack
const AA_SPEED_START = 14.0;
const AA_SPEED_MAX   = 24.0;
const AA_ACCEL       = 28.0;
const AA_RANGE     = 17.0;
const AA_RADIUS    = 0.28;
const AA_DAMAGE    = 12;
const AA_COOLDOWN_MS = 700;

// R ultimate (Trueshot Barrage)
const R_SPEED_START = 9.0;
const R_SPEED_MAX   = 36.0;
const R_ACCEL       = 18.0;
const R_RANGE      = 60.0;
const R_RADIUS     = 1.45;
const R_DAMAGE     = 80;
const R_COOLDOWN_MS = 2500;
const R_COST       = 75;
const R_CAST_MS    = 2000;

const PLAYER_RADIUS = 0.6;

// E blink
const E_RANGE = 7.5;
const E_WALL_OVERREACH = 1.4;
const E_COOLDOWN_MS = 8000;
const E_OUT_MS = 80;
const E_IN_MS  = 140;
const E_COST   = 50;

// W sprint
const W_SPEED_MULT = 1.3;
const W_DURATION_MS = 8000;
const W_COST = 30;
const UP_MAX = 5;

// camera pan
const CAM_PAN_EDGE = 0.82;
const CAM_PAN_SPEED = 24.0;

// pickups
const PICKUP_RADIUS = 0.6;
const DOG_MAX_HP = 90;

const INTERP_DELAY_MS = 120; // remote interpolation
const SEND_HZ = 20;

function upgradeCost(kind, lvl) {
  return 3;
}

function myAbilityStats() {
  return {
    qDmg: Q_DAMAGE + myUp.q * 10,
    wDuration: W_DURATION_MS + myUp.w * 1200,
    eRange: E_RANGE + myUp.e * 1.1,
    rRadius: R_RADIUS + myUp.r * 0.32,
    rDmg: R_DAMAGE + myUp.r * 26,
  };
}

function refreshSpellbookUi() {
  if (!spellbookPanel) return;
  upHpEl.textContent = `${myUp.hp}/${UP_MAX}`;
  upManaEl.textContent = `${myUp.mana}/${UP_MAX}`;
  upQEl.textContent = `${myUp.q}/${UP_MAX}`;
  upWEl.textContent = `${myUp.w}/${UP_MAX}`;
  upEEl.textContent = `${myUp.e}/${UP_MAX}`;
  upREl.textContent = `${myUp.r}/${UP_MAX}`;
  const lvlByKind = { hp: myUp.hp, mana: myUp.mana, q: myUp.q, w: myUp.w, e: myUp.e, r: myUp.r };
  for (const btn of spellbookRows) {
    const kind = btn.dataset.upgrade;
    const lvl = lvlByKind[kind] || 0;
    const cost = upgradeCost(kind, lvl);
    btn.title = lvl >= UP_MAX ? 'MAX' : `Cena: ${cost} Prémie`;
    btn.disabled = lvl >= UP_MAX || myGold < cost;
  }
  if (goldText) goldText.textContent = String(myGold);
}

// ---------------- DOM / modal ----------------
const nameModal = document.getElementById('name-modal');
const nameInput = document.getElementById('name-input');
const nameGo    = document.getElementById('name-go');

const hpText = document.getElementById('hp-text');
const hpFill = document.getElementById('hp-fill');
const mpText = document.getElementById('mp-text');
const mpFill = document.getElementById('mp-fill');
const goldText = document.getElementById('gold-text');
const buffWIndicator = document.getElementById('buff-w-indicator');
const slotQ     = document.getElementById('slot-q');
const slotQMask = document.getElementById('slot-q-mask');
const slotW     = document.getElementById('slot-w');
const slotWMask = document.getElementById('slot-w-mask');
const slotE     = document.getElementById('slot-e');
const slotEMask = document.getElementById('slot-e-mask');
const slotR     = document.getElementById('slot-r');
const slotRMask = document.getElementById('slot-r-mask');
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
const spellbookPanel = document.getElementById('spellbook-panel');
const respawnIndicator = document.getElementById('respawn-indicator');
const spellbookRows = Array.from(document.querySelectorAll('#spellbook-panel .sb-row'));
const upHpEl = document.getElementById('u-hp');
const upManaEl = document.getElementById('u-mana');
const upQEl = document.getElementById('u-q');
const upWEl = document.getElementById('u-w');
const upEEl = document.getElementById('u-e');
const upREl = document.getElementById('u-r');
const rCastWrap = document.getElementById('r-cast-wrap');
const rCastFill = document.getElementById('r-cast-fill');

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
const GROUND_HX = 36, GROUND_HZ = 22;
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

  const face = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xe8f6ff, emissive: 0x9adfff, emissiveIntensity: 0.38 })
  );
  face.position.set(0, 1.06, 0.62);
  g.add(face);

  const eyeL = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x11253d, emissive: 0x8de7ff, emissiveIntensity: 0.5 })
  );
  eyeL.position.set(-0.055, 1.08, 0.74);
  g.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.055;
  g.add(eyeR);

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

  const hpSprite = makeHpSprite();
  hpSprite.position.y = 1.85;
  g.add(hpSprite);
  g.userData.hpSprite = hpSprite;

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
function makeTalkSprite(text) {
  const c = document.createElement('canvas');
  c.width = 420; c.height = 76;
  const ctx = c.getContext('2d');
  drawTalkSprite(ctx, text || '');
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(3.8, 0.72, 1);
  sp.userData.ctx = ctx;
  sp.userData.tex = tex;
  return sp;
}
function drawTalkSprite(ctx, text) {
  ctx.clearRect(0, 0, 420, 76);
  if (!text) return;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, 6, 8, 408, 56, 10);
  ctx.fill();
  ctx.font = 'bold 28px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8f7ff';
  ctx.fillText(text, 210, 36);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function setTalkSprite(sp, text) {
  drawTalkSprite(sp.userData.ctx, text || '');
  sp.userData.tex.needsUpdate = true;
}
function makeHpSprite() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 24;
  const ctx = c.getContext('2d');
  drawHpSprite(ctx, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.7, 0.28, 1);
  sp.userData.canvas = c;
  sp.userData.ctx = ctx;
  sp.userData.tex = tex;
  return sp;
}
function drawHpSprite(ctx, ratio) {
  const w = 128, h = 24;
  const innerX = 4, innerY = 6, innerW = 120, innerH = 12;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#3b1f30';
  ctx.fillRect(innerX, innerY, innerW, innerH);
  ctx.fillStyle = '#ff5d7a';
  ctx.fillRect(innerX, innerY, Math.max(0, Math.min(innerW, innerW * ratio)), innerH);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.strokeRect(innerX + 0.5, innerY + 0.5, innerW - 1, innerH - 1);
}
function setHpSprite(sp, hp, maxHp) {
  const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  drawHpSprite(sp.userData.ctx, ratio);
  sp.userData.tex.needsUpdate = true;
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

function makeNPCMesh(n) {
  const g = new THREE.Group();
  const isReditel = n.kind === 'reditel';
  const isDog = n.kind === 'pes';
  if (isDog) {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8c6a45, roughness: 0.7, metalness: 0.02, emissive: 0x3d2a18, emissiveIntensity: 0.2 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xa67b4f, roughness: 0.65, metalness: 0.02 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.55, 0.62), bodyMat);
    body.position.y = 0.58;
    g.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.43, 0.45), headMat);
    head.position.set(0, 0.72, 0.72);
    g.add(head);
    const earMat = new THREE.MeshStandardMaterial({ color: 0x3f2b17, roughness: 0.8 });
    const earL = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 8), earMat);
    earL.position.set(-0.13, 0.95, 0.76);
    earL.rotation.x = Math.PI;
    g.add(earL);
    const earR = earL.clone();
    earR.position.x = 0.13;
    g.add(earR);
    const legGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.44, 8);
    const legPos = [[-0.42, 0.24, 0.22], [0.42, 0.24, 0.22], [-0.42, 0.24, -0.2], [0.42, 0.24, -0.2]];
    for (const p of legPos) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(p[0], p[1], p[2]);
      g.add(leg);
    }
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.42, 8), bodyMat);
    tail.position.set(0, 0.72, -0.72);
    tail.rotation.x = -0.8;
    g.add(tail);
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshStandardMaterial({ color: 0x1d130d, emissive: 0x3a2516, emissiveIntensity: 0.35 }));
    muzzle.position.set(0, 0.65, 0.98);
    g.add(muzzle);
  } else if (isReditel) {
    // Reditel is intentionally wider/fatter, not just uniformly larger.
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcaa06a, roughness: 0.55, metalness: 0.05, emissive: 0x604222, emissiveIntensity: 0.2 });
    const torso = new THREE.Mesh(new THREE.SphereGeometry(0.88, 20, 14), bodyMat);
    torso.scale.set(1.18, 0.92, 1.04);
    torso.position.y = 0.98;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf4e2c8, roughness: 0.6 }));
    head.position.set(0, 1.68, 0.3);
    g.add(head);
    const face = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xf4f9ff, emissive: 0x8adfff, emissiveIntensity: 0.25 })
    );
    face.position.set(0, 1.7, 0.62);
    g.add(face);
  } else {
    const color = 0x86c2ff;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, 0.9, 4, 8),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, emissive: color, emissiveIntensity: 0.12 })
    );
    body.position.y = 0.95;
    g.add(body);
    const face = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xf4f9ff, emissive: 0x8adfff, emissiveIntensity: 0.25 })
    );
    face.position.set(0, 1.12, 0.65);
    g.add(face);
  }

  const nameSp = makeNameSprite(n.name || n.kind);
  nameSp.position.y = isDog ? 1.65 : 2.45;
  g.add(nameSp);

  if (isDog) {
    const hpSp = makeHpSprite();
    hpSp.position.y = 1.95;
    g.add(hpSp);
    g.userData.hpSprite = hpSp;
  }

  const talkSp = makeTalkSprite('');
  talkSp.position.y = isDog ? 2.2 : 3.1;
  talkSp.visible = false;
  g.add(talkSp);

  g.scale.setScalar(n.scale || 1);
  g.userData.nameSprite = nameSp;
  g.userData.talkSprite = talkSp;
  return g;
}

function updateNPCsFromSnapshot(snap) {
  const seen = new Set();
  for (const n of (snap.npcs || [])) {
    seen.add(n.id);
    let obj = npcs.get(n.id);
    if (!obj) {
      const mesh = makeNPCMesh(n);
      scene.add(mesh);
      obj = { id: n.id, mesh, kind: n.kind, name: n.name, hp: n.hp || 0, alive: n.alive !== false, say: '', sayUntil: 0 };
      npcs.set(n.id, obj);
    }
    obj.id = n.id;
    obj.kind = n.kind;
    obj.name = n.name;
    obj.hp = n.hp || 0;
    obj.alive = n.alive !== false;
    obj.mesh.position.set(n.x, 0, n.z);
    obj.mesh.rotation.y = n.facing || 0;
    obj.mesh.scale.setScalar(n.scale || 1);
    obj.mesh.visible = obj.alive;
    setNameSprite(obj.mesh.userData.nameSprite, n.name || n.kind, '#e6f2ff');
    if (obj.kind === 'pes' && obj.mesh.userData.hpSprite) {
      setHpSprite(obj.mesh.userData.hpSprite, obj.hp, DOG_MAX_HP);
      obj.mesh.userData.hpSprite.visible = obj.alive;
    }
    obj.say = n.say || '';
    obj.sayUntil = n.sayUntil || 0;
    if (obj.say) setTalkSprite(obj.mesh.userData.talkSprite, obj.say);
  }
  for (const id of [...npcs.keys()]) {
    if (!seen.has(id)) {
      const n = npcs.get(id);
      scene.remove(n.mesh);
      n.mesh.userData.nameSprite.userData.tex.dispose();
      n.mesh.userData.talkSprite.userData.tex.dispose();
      n.mesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material.dispose();
        }
      });
      npcs.delete(id);
    }
  }
}

function updateNpcTalkVisibility() {
  const nowMs = Date.now();
  for (const n of npcs.values()) {
    const sp = n.mesh.userData.talkSprite;
    if (!n.alive || !n.say || nowMs > n.sayUntil) {
      sp.visible = false;
      continue;
    }
    sp.visible = true;
  }
}

// ---------------- networking ----------------
let ws = null;
let myId = 0;
let serverHalfX = GROUND_HX, serverHalfZ = GROUND_HZ;
let startHP = 100;
let startMana = 100;
let myMana = 100; // optimistic local prediction; corrected by snapshots
let myGold = 0;
let myUp = { hp: 0, mana: 0, q: 0, w: 0, e: 0, r: 0 };

const players = new Map(); // id -> { mesh, name, hp, alive, snapshots: [{t,x,z,facing}], lastSeen }
const projectiles = []; // {pid, owner, x, z, vx, vz, dist, max, mesh, hitDone}
const pickups = new Map(); // id -> { kind, x, z, mesh }
const npcs = new Map(); // id -> { mesh, kind, name, say, sayUntil }

let myProjectileSeq = 1;
let qReadyAt = 0;
let qBurstUntil = 0;
let qBurstNextShotAt = 0;
let wActiveUntil = 0;
let eReadyAt = 0;
let rReadyAt = 0;
let aaReadyAt = 0;
let rCastUntil = 0;
let teleportMode = false;
let qMode = false;
let rMode = false;

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

function clampToMap(x, z) {
  return {
    x: Math.max(-serverHalfX + PLAYER_RADIUS, Math.min(serverHalfX - PLAYER_RADIUS, x)),
    z: Math.max(-serverHalfZ + PLAYER_RADIUS, Math.min(serverHalfZ - PLAYER_RADIUS, z)),
  };
}

function isTeleportBlocked(x, z) {
  if (pointInObstacle(x, z, PLAYER_RADIUS)) return true;

  for (const [id, pl] of players) {
    if (id === myId || !pl.alive) continue;
    const dx = pl.mesh.position.x - x;
    const dz = pl.mesh.position.z - z;
    if (dx * dx + dz * dz < (PLAYER_RADIUS * 2) ** 2 * 0.9) return true;
  }

  for (const n of npcs.values()) {
    if (!n.alive) continue;
    const nRad = n.kind === 'reditel' ? 1.0 : 0.72;
    const dx = n.mesh.position.x - x;
    const dz = n.mesh.position.z - z;
    if (dx * dx + dz * dz < (PLAYER_RADIUS + nRad) ** 2 * 0.9) return true;
  }

  return false;
}

function findTeleportSpot(targetX, targetZ, maxSearchRadius = 2.8) {
  const primary = clampToMap(targetX, targetZ);
  if (!isTeleportBlocked(primary.x, primary.z)) return primary;

  const step = 0.2;
  const samples = 24;
  for (let r = step; r <= maxSearchRadius + 0.001; r += step) {
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2;
      const cand = clampToMap(targetX + Math.cos(a) * r, targetZ + Math.sin(a) * r);
      if (!isTeleportBlocked(cand.x, cand.z)) return cand;
    }
  }
  return null;
}

const aimLineMat = new THREE.LineBasicMaterial({ color: 0x80e7ff, transparent: true, opacity: 0.9 });
const aimLineGeom = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0.08, 0),
  new THREE.Vector3(0, 0.08, 0),
]);
const aimLine = new THREE.Line(aimLineGeom, aimLineMat);
aimLine.visible = false;
scene.add(aimLine);

const sprintTrailMat = new THREE.LineBasicMaterial({ color: 0xa9f6ff, transparent: true, opacity: 0.55 });
const sprintTrailGeom = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0.8, 0),
  new THREE.Vector3(0, 0.8, 0),
]);
const sprintTrail = new THREE.Line(sprintTrailGeom, sprintTrailMat);
sprintTrail.visible = false;
scene.add(sprintTrail);

const teleportRangeMat = new THREE.MeshBasicMaterial({ color: 0x78c3ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
const teleportRange = new THREE.Mesh(new THREE.CircleGeometry(E_RANGE, 40), teleportRangeMat);
teleportRange.rotation.x = -Math.PI / 2;
teleportRange.position.y = 0.04;
teleportRange.visible = false;
scene.add(teleportRange);

const blink = { active: false, start: 0 };
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const camDesiredPos = new THREE.Vector3();
const camDesiredLook = new THREE.Vector3();
const cameraAnchor = new THREE.Vector2(0, 0);
let camReady = false;
let camRecenterBoostUntil = 0;

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
      startMana = m.data.startMana || 100;
      myMana = startMana;
      myGold = 0;
      myUp = { hp: 0, mana: 0, q: 0, w: 0, e: 0, r: 0 };
      refreshSpellbookUi();
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
      pl = { mesh, name: p.name, hp: p.hp, mana: p.mana, alive: p.alive, snapshots: [], color };
      players.set(p.id, pl);
      setNameSprite(mesh.userData.nameSprite, p.name, p.id === myId ? '#6cf' : '#e6e8ee');
    }
    if (pl.name !== p.name) {
      pl.name = p.name;
      setNameSprite(pl.mesh.userData.nameSprite, p.name, p.id === myId ? '#6cf' : '#e6e8ee');
    }
    const wasAlive = pl.alive;
    pl.hp = p.hp;
    pl.mana = p.mana;
    pl.maxHp = p.maxHp || startHP;
    pl.maxMana = p.maxMana || startMana;
    pl.gold = p.gold || 0;
    pl.upHp = p.upHp || 0;
    pl.upMana = p.upMana || 0;
    pl.upQ = p.upQ || 0;
    pl.upW = p.upW || 0;
    pl.upE = p.upE || 0;
    pl.upR = p.upR || 0;
    pl.respawnAt = p.respawnAt || 0;
    pl.alive = p.alive;
    if (pl.mesh.userData.hpSprite) {
      setHpSprite(pl.mesh.userData.hpSprite, p.hp, pl.maxHp);
      pl.mesh.userData.hpSprite.visible = p.id !== myId && p.alive;
    }
    if (p.id !== myId) {
      pl.snapshots.push({ t: snap.t, x: p.x, z: p.z, facing: p.facing });
      // trim to last 1s
      const cutoff = snap.t - 1000;
      while (pl.snapshots.length > 2 && pl.snapshots[0].t < cutoff) pl.snapshots.shift();
    }
    // visibility on death
    pl.mesh.visible = p.alive;
    // server-driven (re)spawn position for me: always snap on dead->alive,
    // first sync, or if we somehow drift far from authority.
    if (p.id === myId) {
      const desync = Math.hypot(myPos.x - p.x, myPos.z - p.z);
      if (pl._initSync !== true || (!wasAlive && p.alive) || desync > 2.5) {
        myPos.x = p.x; myPos.z = p.z;
        myVel.set(0, 0);
        centerCameraOnMe(true);
        pl._initSync = true;
      }
    }
  }
  // any local player not in snapshot → remove
  for (const id of [...players.keys()]) {
    if (!seenIds.has(id)) removePlayer(id);
  }
  // update my HP/Mana from snapshot
  const me = players.get(myId);
  if (me) {
    const maxHp = me.maxHp || startHP;
    const maxMana = me.maxMana || startMana;
    hpText.textContent = `${me.hp}/${maxHp}`;
    hpFill.style.width = `${Math.max(0, me.hp) / maxHp * 100}%`;
    if (typeof me.mana === 'number') {
      // Server is authoritative; if local prediction undershot, snap up.
      if (me.mana > myMana) myMana = me.mana;
      // If server is lower than our prediction, accept it (we predicted too
      // optimistically or another cast was rejected).
      if (me.mana < myMana - 2) myMana = me.mana;
    }
    myGold = me.gold || 0;
    myUp = {
      hp: me.upHp || 0,
      mana: me.upMana || 0,
      q: me.upQ || 0,
      w: me.upW || 0,
      e: me.upE || 0,
      r: me.upR || 0,
    };
    mpText.textContent = `${Math.round(myMana)}/${maxMana}`;
    mpFill.style.width = `${Math.max(0, myMana) / maxMana * 100}%`;
    refreshSpellbookUi();
  }
  // pickups diff
  const pkSeen = new Set();
  if (Array.isArray(snap.pickups)) {
    for (const pk of snap.pickups) {
      pkSeen.add(pk.id);
      if (!pickups.has(pk.id)) {
        spawnPickupMesh(pk);
      } else {
        const cur = pickups.get(pk.id);
        cur.expireAtMs = pk.expireAtMs || cur.expireAtMs || 0;
      }
    }
  }
  for (const id of [...pickups.keys()]) {
    if (!pkSeen.has(id)) removePickup(id);
  }
  updateNPCsFromSnapshot(snap);
  refreshPlayerList();
}

function removePlayer(id) {
  const pl = players.get(id);
  if (!pl) return;
  scene.remove(pl.mesh);
  pl.mesh.userData.nameSprite.userData.tex.dispose();
  if (pl.mesh.userData.hpSprite?.userData?.tex) {
    pl.mesh.userData.hpSprite.userData.tex.dispose();
  }
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
  // Player list panel may be absent depending on HUD layout.
  const playerListEl = document.getElementById('player-list');
  if (!playerListEl) return;
  const rows = [];
  const sorted = [...players.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sorted) {
    const dead = p.alive ? '' : ' <span class="muted">(dead)</span>';
    rows.push(`<div class="row"><span>${escapeHtml(p.name)}</span><span class="muted">${p.hp}${dead}</span></div>`);
  }
  playerListEl.innerHTML = rows.join('');
}

function pushKillfeed(_html) { /* killfeed removed */ }

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
  if (e.code === 'KeyQ') {
    e.preventDefault();
    tryFireQ();
  } else if (e.code === 'KeyW') {
    e.preventDefault();
    tryCastW();
  } else if (e.code === 'KeyE') {
    e.preventDefault();
    tryEnterTeleportMode();
  } else if (e.code === 'KeyR') {
    e.preventDefault();
    tryEnterRMode();
  } else if (e.code === 'Space') {
    e.preventDefault();
    centerCameraOnMe();
  } else if (e.code === 'Escape') {
    clearAbilityModes();
  }
});

slotQ.addEventListener('click', () => {
  tryFireQ();
});
slotW.addEventListener('click', () => {
  tryCastW();
});
slotE.addEventListener('click', () => {
  if (teleportMode) {
    teleportMode = false;
    slotE.classList.remove('targeting');
    return;
  }
  tryEnterTeleportMode();
});
slotR.addEventListener('click', () => {
  if (rMode) {
    rMode = false;
    slotR.classList.remove('targeting');
    return;
  }
  tryEnterRMode();
});

for (const row of spellbookRows) {
  row.addEventListener('click', () => {
    const kind = row.dataset.upgrade;
    if (!kind) return;
    send({ type: 'upgrade', data: { kind } });
  });
}

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
    } else if (rMode) {
      tryFireR();
    } else if (qMode) {
      tryFireQ();
    } else {
      tryAutoAttack();
    }
  } else if (e.button === 2) {
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
minimapCanvas.addEventListener('contextmenu', e => e.preventDefault());
document.querySelector('.hp-center-panel')?.addEventListener('contextmenu', e => e.preventDefault());
document.getElementById('ability-bar')?.addEventListener('contextmenu', e => e.preventDefault());
spellbookPanel?.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('contextmenu', e => e.preventDefault());

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
const myVel = new THREE.Vector2(0, 0);
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
  myVel.set(0, 0);
  wActiveUntil = 0;
  teleportMode = false;
  qMode = false;
  rMode = false;
  blink.active = false;
  camReady = false;
  slotE.classList.remove('targeting');
  slotQ.classList.remove('targeting');
  slotR.classList.remove('targeting');
  centerCameraOnMe();
}

function centerCameraOnMe(snap = false) {
  const b = getCameraAnchorBounds();
  cameraAnchor.x = Math.max(b.minX, Math.min(b.maxX, myPos.x));
  cameraAnchor.y = Math.max(b.minZ, Math.min(b.maxZ, myPos.z));
  if (snap) camReady = false;
  else camRecenterBoostUntil = performance.now() + 320;
}

function getCameraAnchorBounds() {
  // Full arena pan range for camera anchor.
  return { minX: -serverHalfX, maxX: serverHalfX, minZ: -serverHalfZ, maxZ: serverHalfZ };
}

function clearAbilityModes() {
  qMode = false;
  teleportMode = false;
  rMode = false;
  slotQ.classList.remove('targeting');
  slotE.classList.remove('targeting');
  slotR.classList.remove('targeting');
}

function tryEnterQMode() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (performance.now() < qBurstUntil) return;
  if (performance.now() < qReadyAt) return;
  if (myMana < Q_COST) return;
  qMode = true;
  slotQ.classList.add('targeting');
  if (teleportMode) { teleportMode = false; slotE.classList.remove('targeting'); }
  if (rMode)        { rMode = false;        slotR.classList.remove('targeting'); }
}

function tryEnterRMode() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (performance.now() < rReadyAt) return;
  if (myMana < R_COST) return;
  rMode = true;
  slotR.classList.add('targeting');
  if (teleportMode) { teleportMode = false; slotE.classList.remove('targeting'); }
  if (qMode)        { qMode = false;        slotQ.classList.remove('targeting'); }
}

function tryCastW() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < wActiveUntil) return;
  if (myMana < W_COST) return;
  const stats = myAbilityStats();
  wActiveUntil = now + stats.wDuration;
  myMana = Math.max(0, myMana - W_COST);
  send({ type: 'cast', data: { kind: 'w' } });
}

function tryEnterTeleportMode() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (performance.now() < eReadyAt) return;
  if (myMana < E_COST) return;
  teleportMode = true;
  slotE.classList.add('targeting');
  if (qMode) { qMode = false; slotQ.classList.remove('targeting'); }
  if (rMode) { rMode = false; slotR.classList.remove('targeting'); }
}

function tryTeleport() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < eReadyAt) return;
  if (myMana < E_COST) return;

  const dx = mouseWorld.x - myPos.x;
  const dz = mouseWorld.z - myPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) return;

  const ux = dx / dist, uz = dz / dist;
  const stats = myAbilityStats();
  const clickLimit = stats.eRange + E_WALL_OVERREACH;
  if (dist > clickLimit + 0.001) return;
  const want = Math.min(clickLimit, dist);
  const targetX = myPos.x + ux * want;
  const targetZ = myPos.z + uz * want;
  const spot = findTeleportSpot(targetX, targetZ, Math.max(2.8, PLAYER_RADIUS + 1.9));
  if (!spot) return;

  myPos.x = spot.x;
  myPos.z = spot.z;
  hasMoveTarget = false;

  eReadyAt = now + E_COOLDOWN_MS;
  myMana = Math.max(0, myMana - E_COST);
  teleportMode = false;
  slotE.classList.remove('targeting');

  blink.active = true;
  blink.start = now;

  send({ type: 'cast', data: { kind: 'e' } });
  send({ type: 'state', data: { x: myPos.x, z: myPos.z, facing: myFacing } });
}

// ---------------- projectiles ----------------
function tryFireQ() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < qBurstUntil) return;
  if (now < qReadyAt) return;
  if (myMana < Q_COST) return;
  qReadyAt = now + Q_COOLDOWN_MS;
  myMana = Math.max(0, myMana - Q_COST);
  qMode = false;
  slotQ.classList.remove('targeting');
  qBurstUntil = now + Q_BURST_MS;
  qBurstNextShotAt = now;
  send({ type: 'cast', data: { kind: 'q' } });
}

function tryFireR() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < rReadyAt) return;
  if (rCastUntil > now) return;
  if (myMana < R_COST) return;

  rReadyAt = now + R_COOLDOWN_MS;
  rCastUntil = now + R_CAST_MS;
  myMana = Math.max(0, myMana - R_COST);
  rMode = false;
  slotR.classList.remove('targeting');
}

function tryAutoAttack() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  const now = performance.now();
  if (now < aaReadyAt) return;
  aaReadyAt = now + AA_COOLDOWN_MS;
  fireProjectile('aa');
}

function fireProjectile(kind, dir = null) {
  let dx;
  let dz;
  if (dir) {
    dx = dir.x;
    dz = dir.y;
  } else {
    dx = mouseWorld.x - myPos.x;
    dz = mouseWorld.z - myPos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) {
      dx = Math.sin(myFacing); dz = Math.cos(myFacing);
    } else {
      dx /= len; dz /= len;
    }
  }
  const pid = myProjectileSeq++;
  const ox = myPos.x + dx * (PLAYER_RADIUS + 0.3);
  const oz = myPos.z + dz * (PLAYER_RADIUS + 0.3);
  const boost = myAbilityStats();
  spawnProjectile({ owner: myId, pid, ox, oz, dx, dz, kind, boost });
  send({ type: 'fire', data: { pid, ox, oz, dx, dz, kind } });
}

function projectileSpec(kind, boost = null) {
  const b = boost || { qDmg: Q_DAMAGE, rRadius: R_RADIUS, rDmg: R_DAMAGE };
  switch (kind) {
    case 'reditel':
      return { radius: 0.22, startSpeed: 12.0, maxSpeed: 12.0, accel: 0, range: 10.0, dmg: 9, pierce: true };
    case 'r':
      return { radius: b.rRadius, startSpeed: R_SPEED_START, maxSpeed: R_SPEED_MAX, accel: R_ACCEL, range: R_RANGE, dmg: b.rDmg, pierce: true };
    case 'aa':
      return { radius: AA_RADIUS, startSpeed: AA_SPEED_START, maxSpeed: AA_SPEED_MAX, accel: AA_ACCEL, range: AA_RANGE, dmg: AA_DAMAGE, pierce: false };
    default:
      return { radius: Q_RADIUS, startSpeed: Q_SPEED_START, maxSpeed: Q_SPEED_MAX, accel: Q_ACCEL, range: Q_RANGE, dmg: b.qDmg, pierce: false };
  }
}

function spawnProjectile(p) {
  const kind = p.kind || 'q';
  const spec = projectileSpec(kind, p.boost || null);
  let color;
  if (kind === 'reditel') color = 0xffc46b;
  else if (kind === 'r')      color = p.owner === myId ? 0xff7df6 : 0xff5dc8;
  else if (kind === 'aa') color = p.owner === myId ? 0xa6f0ff : 0xfff0a0;
  else                    color = p.owner === myId ? 0xffe48a : 0xff9b66;

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(spec.radius, 22, 16),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: kind === 'r' ? 1.1 : 0.85 })
  );
  mesh.position.set(p.ox, 1.0, p.oz);
  scene.add(mesh);

  const light = new THREE.PointLight(color, kind === 'r' ? 1.6 : (kind === 'q' ? 1.0 : 0.5), kind === 'r' ? 8 : (kind === 'q' ? 5 : (kind === 'reditel' ? 5 : 3)));
  mesh.add(light);

  projectiles.push({
    pid: p.pid,
    owner: p.owner,
    x: p.ox, z: p.oz,
    dirX: p.dx, dirZ: p.dz,
    speed: spec.startSpeed,
    maxSpeed: spec.maxSpeed,
    accel: spec.accel,
    radius: spec.radius, range: spec.range, dmg: spec.dmg, pierce: spec.pierce,
    kind,
    dist: 0,
    mesh,
    hitDone: false,
    hitSet: new Set(),
  });
}

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.speed = Math.min(pr.maxSpeed, pr.speed + pr.accel * dt);
    const stepX = pr.dirX * pr.speed * dt;
    const stepZ = pr.dirZ * pr.speed * dt;
    pr.x += stepX;
    pr.z += stepZ;
    pr.dist += Math.hypot(stepX, stepZ);
    pr.mesh.position.x = pr.x;
    pr.mesh.position.z = pr.z;

    // wall collision (R pierces walls)
    if (!pr.pierce && pointInObstacle(pr.x, pr.z, pr.radius)) {
      disposeProjectile(i);
      continue;
    }

    // neutral NPCs can body-block projectiles
    let blockedByNpc = false;
    for (const n of npcs.values()) {
      if (!n.alive || n.kind === 'pes') continue;
      if (Number(n.id) === pr.owner) continue;
      const dxn = n.mesh.position.x - pr.x;
      const dzn = n.mesh.position.z - pr.z;
      const nRad = n.kind === 'reditel' ? 1.05 : 0.72;
      if (dxn * dxn + dzn * dzn <= (pr.radius + nRad) ** 2) {
        blockedByNpc = true;
        break;
      }
    }
    if (blockedByNpc) {
      disposeProjectile(i);
      continue;
    }

    // shooter checks hits (client-authoritative)
    if (pr.owner === myId) {
      for (const [pid, pl] of players) {
        if (pid === myId || !pl.alive) continue;
        if (pr.hitSet.has(pid)) continue;
        const tx = pl.mesh.position.x;
        const tz = pl.mesh.position.z;
        const dx = tx - pr.x, dz = tz - pr.z;
        const extra = pr.kind === 'r' ? 0.35 : 0.0;
        if (dx * dx + dz * dz <= (pr.radius + PLAYER_RADIUS + extra) ** 2) {
          pr.hitSet.add(pid);
          send({ type: 'hit', data: { pid: pr.pid, target: pid, dmg: pr.dmg } });
          if (!pr.pierce) {
            disposeProjectile(i);
            break;
          }
        }
      }
      for (const [nid, n] of npcs) {
        if (n.kind !== 'pes' || !n.alive) continue;
        const nk = `n${nid}`;
        if (pr.hitSet.has(nk)) continue;
        const tx = n.mesh.position.x;
        const tz = n.mesh.position.z;
        const dx = tx - pr.x;
        const dz = tz - pr.z;
        const npcRadius = 0.6;
        if (dx * dx + dz * dz <= (pr.radius + npcRadius) ** 2) {
          pr.hitSet.add(nk);
          send({ type: 'hit', data: { pid: pr.pid, target: Number(nid), dmg: pr.dmg } });
          if (!pr.pierce) {
            disposeProjectile(i);
            break;
          }
        }
      }
      if (!projectiles[i]) continue; // disposed above
    }

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

// ---------------- pickups ----------------
function spawnPickupMesh(pk) {
  const isHP = pk.kind === 'hp';
  const isGold = pk.kind === 'gold';
  const color = isHP ? 0xff5d8c : (isGold ? 0xffd45b : 0x56d9ff);
  const baseOpacity = 0.55;
  const g = new THREE.Group();
  const orbMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.85, transparent: true, opacity: 1.0 });
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 16, 12),
    orbMat
  );
  orb.position.y = 0.5;
  g.add(orb);
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: baseOpacity, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.6, 24),
    ringMat
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  g.add(ring);
  const light = new THREE.PointLight(color, 0.5, 3);
  light.position.y = 0.5;
  g.add(light);
  g.position.set(pk.x, 0, pk.z);
  scene.add(g);
  pickups.set(pk.id, {
    id: pk.id,
    kind: pk.kind,
    x: pk.x,
    z: pk.z,
    mesh: g,
    t0: performance.now(),
    expireAtMs: pk.expireAtMs || 0,
    ringBaseOpacity: baseOpacity,
    orbMat,
    ringMat,
    light,
  });
}

function removePickup(id) {
  const pk = pickups.get(id);
  if (!pk) return;
  scene.remove(pk.mesh);
  pk.mesh.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material.dispose();
    }
  });
  pickups.delete(id);
}

function updatePickups() {
  const now = performance.now();
  const nowMs = Date.now();
  for (const pk of pickups.values()) {
    pk.mesh.position.y = Math.sin((now - pk.t0) / 400) * 0.08;
    pk.mesh.rotation.y = (now - pk.t0) / 600;

    if (pk.expireAtMs > 0) {
      const remain = pk.expireAtMs - nowMs;
      const fade = remain <= 10000 ? Math.max(0, Math.min(1, remain / 10000)) : 1;
      pk.orbMat.opacity = 0.2 + 0.8 * fade;
      pk.ringMat.opacity = pk.ringBaseOpacity * (0.25 + 0.75 * fade);
      pk.light.intensity = 0.15 + 0.35 * fade;
    }
  }
  // collection check
  const me = players.get(myId);
  if (!me || !me.alive) return;
  for (const pk of pickups.values()) {
    const dx = pk.x - myPos.x;
    const dz = pk.z - myPos.z;
    if (dx * dx + dz * dz <= (PICKUP_RADIUS + PLAYER_RADIUS) ** 2) {
      send({ type: 'pickup', data: { id: pk.id } });
      removePickup(pk.id); // optimistic; snapshot will reconcile
    }
  }
}

// ---------------- minimap ----------------
function drawMinimap() {
  const W = minimapCanvas.width, H = minimapCanvas.height;
  const ctx = minimapCtx;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#102040';
  ctx.fillRect(0, 0, W, H);
  // map -> minimap helpers
  const sx = (x) => ((x + serverHalfX) / (2 * serverHalfX)) * W;
  const sz = (z) => ((z + serverHalfZ) / (2 * serverHalfZ)) * H;
  // obstacles
  ctx.fillStyle = '#3b5d96';
  for (const o of obstacles) {
    const x0 = sx(o.minX), x1 = sx(o.maxX);
    const z0 = sz(o.minZ), z1 = sz(o.maxZ);
    ctx.fillRect(x0, z0, Math.max(1, x1 - x0), Math.max(1, z1 - z0));
  }
  // pickups
  for (const pk of pickups.values()) {
    ctx.fillStyle = pk.kind === 'hp' ? '#ff5d8c' : (pk.kind === 'gold' ? '#ffd45b' : '#56d9ff');
    ctx.beginPath();
    ctx.arc(sx(pk.x), sz(pk.z), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // players
  for (const [id, pl] of players) {
    if (!pl.alive) continue;
    const x = sx(pl.mesh.position.x);
    const z = sz(pl.mesh.position.z);
    ctx.fillStyle = id === myId ? '#9bf' : '#ffe06b';
    ctx.beginPath();
    ctx.arc(x, z, id === myId ? 3.5 : 2.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // npcs
  for (const n of npcs.values()) {
    if (!n.alive) continue;
    ctx.fillStyle = n.kind === 'reditel' ? '#ffc38a' : (n.kind === 'pes' ? '#ff9a7d' : '#8af7ff');
    ctx.beginPath();
    ctx.arc(sx(n.mesh.position.x), sz(n.mesh.position.z), n.kind === 'reditel' ? 3.5 : 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // camera view border on minimap (approximate visible ground window)
  const viewHalfX = 12;
  const viewHalfZ = 8;
  ctx.strokeStyle = 'rgba(214, 242, 255, 0.9)';
  ctx.lineWidth = 1.25;
  const vx0 = sx(cameraAnchor.x - viewHalfX);
  const vx1 = sx(cameraAnchor.x + viewHalfX);
  const vz0 = sz(cameraAnchor.y - viewHalfZ);
  const vz1 = sz(cameraAnchor.y + viewHalfZ);
  ctx.strokeRect(vx0, vz0, Math.max(1, vx1 - vx0), Math.max(1, vz1 - vz0));
  // border
  ctx.strokeStyle = '#56d9ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
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

  if (respawnIndicator) {
    if (me && !alive && me.respawnAt) {
      const remainMS = Math.max(0, me.respawnAt - Date.now());
      const remain = Math.ceil(remainMS / 1000);
      respawnIndicator.hidden = false;
      respawnIndicator.textContent = `Respawn in ${remain}s`;
    } else {
      respawnIndicator.hidden = true;
    }
  }

  // local movement: right-click to move with immediate direction changes
  if (alive) {
    const sprintActive = performance.now() < wActiveUntil;
    const moveSpeedNow = MOVE_SPEED * (sprintActive ? W_SPEED_MULT : 1);
    myVel.set(0, 0);
    if (hasMoveTarget) {
      const dx = moveTarget.x - myPos.x;
      const dz = moveTarget.y - myPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= 0.06) {
        hasMoveTarget = false;
      } else {
        myVel.x = (dx / dist) * moveSpeedNow;
        myVel.y = (dz / dist) * moveSpeedNow;
      }
    }

    const nx = myPos.x + myVel.x * dt;
    const nz = myPos.z + myVel.y * dt;
    const res = resolveMove(myPos.x, myPos.z, nx, nz, PLAYER_RADIUS);
    const moved = Math.hypot(res.x - myPos.x, res.z - myPos.z);
    myPos.x = res.x; myPos.z = res.z;
    myPos.x = Math.max(-serverHalfX, Math.min(serverHalfX, myPos.x));
    myPos.z = Math.max(-serverHalfZ, Math.min(serverHalfZ, myPos.z));

    if (moved < 0.0005) {
      myVel.set(0, 0);
      if (hasMoveTarget) {
        const rem = Math.hypot(moveTarget.x - myPos.x, moveTarget.y - myPos.z);
        if (rem < 0.25) hasMoveTarget = false;
      }
    }
    if (hasMoveTarget) {
      const rem = Math.hypot(moveTarget.x - myPos.x, moveTarget.y - myPos.z);
      if (rem < 0.08) {
        hasMoveTarget = false;
        myVel.set(0, 0);
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
    qBurstUntil = 0;
    teleportMode = false;
    rMode = false;
    rCastUntil = 0;
    hasMoveTarget = false;
    myVel.set(0, 0);
    sprintTrail.visible = false;
    slotQ.classList.remove('targeting');
    slotE.classList.remove('targeting');
    slotR.classList.remove('targeting');
  }

  if (alive) {
    const nowQ = performance.now();
    while (nowQ < qBurstUntil && nowQ >= qBurstNextShotAt) {
      fireProjectile('q');
      qBurstNextShotAt += Q_BURST_INTERVAL_MS;
    }
    if (rCastUntil > 0 && nowQ >= rCastUntil) {
      fireProjectile('r');
      rCastUntil = 0;
    }
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

    const sprintActive = alive && performance.now() < wActiveUntil;
    if (sprintActive) {
      const backX = -Math.sin(myFacing);
      const backZ = -Math.cos(myFacing);
      const pulse = 0.2 + 0.15 * Math.sin(performance.now() * 0.02);
      const len = 1.8 + pulse;
      const start = new THREE.Vector3(myPos.x, 0.88, myPos.z);
      const end = new THREE.Vector3(myPos.x + backX * len, 0.88, myPos.z + backZ * len);
      sprintTrail.geometry.setFromPoints([start, end]);
      sprintTrailMat.opacity = 0.4 + 0.25 * Math.sin(performance.now() * 0.016);
      sprintTrail.visible = true;
    } else {
      sprintTrail.visible = false;
    }
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
  updatePickups();
  updateNpcTalkVisibility();

  // skillshot / autoattack aim indicator
  if (alive && hasMouse && !teleportMode) {
    const dx = mouseWorld.x - myPos.x;
    const dz = mouseWorld.z - myPos.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.001) {
      const ux = dx / len;
      const uz = dz / len;
      let reach, color, opacity;
      if (rMode)      { reach = R_RANGE; color = 0xff7df6; opacity = 0.95; }
      else if (qMode) { reach = Q_RANGE; color = 0xffe27a; opacity = 0.95; }
      else            { reach = AA_RANGE; color = 0x80e7ff; opacity = 0.45; }
      const start = new THREE.Vector3(myPos.x + ux * (PLAYER_RADIUS + 0.2), 0.08, myPos.z + uz * (PLAYER_RADIUS + 0.2));
      const end = new THREE.Vector3(start.x + ux * reach, 0.08, start.z + uz * reach);
      aimLine.geometry.setFromPoints([start, end]);
      aimLineMat.color.setHex(color);
      aimLineMat.opacity = opacity;
      aimLine.visible = true;
    } else {
      aimLine.visible = false;
    }
  } else {
    aimLine.visible = false;
  }

  teleportRange.visible = teleportMode && alive;
  if (teleportRange.visible) {
    const stats = myAbilityStats();
    teleportRange.position.x = myPos.x;
    teleportRange.position.z = myPos.z;
    const s = stats.eRange / E_RANGE;
    teleportRange.scale.set(s, s, 1);
  }

  // camera: free mouse-pan with fixed angle, clamped inside lobby.
  let panX = 0, panZ = 0;
  if (hasMouse) {
    if (mouseNDC.x > CAM_PAN_EDGE) {
      panX = (mouseNDC.x - CAM_PAN_EDGE) / (1 - CAM_PAN_EDGE);
    } else if (mouseNDC.x < -CAM_PAN_EDGE) {
      panX = (mouseNDC.x + CAM_PAN_EDGE) / (1 - CAM_PAN_EDGE);
    }
    if (mouseNDC.y > CAM_PAN_EDGE) {
      panZ = -(mouseNDC.y - CAM_PAN_EDGE) / (1 - CAM_PAN_EDGE);
    } else if (mouseNDC.y < -CAM_PAN_EDGE) {
      panZ = -(mouseNDC.y + CAM_PAN_EDGE) / (1 - CAM_PAN_EDGE);
    }
  }
  const b = getCameraAnchorBounds();
  cameraAnchor.x = Math.max(b.minX, Math.min(b.maxX, cameraAnchor.x + panX * CAM_PAN_SPEED * dt));
  cameraAnchor.y = Math.max(b.minZ, Math.min(b.maxZ, cameraAnchor.y + panZ * CAM_PAN_SPEED * dt));

  const tx = cameraAnchor.x;
  const tz = cameraAnchor.y;
  const desiredPosX = tx + CAM_OFFSET.x;
  const desiredPosY = CAM_OFFSET.y;
  const desiredPosZ = tz + CAM_OFFSET.z;
  const desiredLookX = tx;
  const desiredLookY = 0.0;
  const desiredLookZ = tz + CAM_LOOK_OFFSET_Z;

  if (!camReady) {
    camPos.set(desiredPosX, desiredPosY, desiredPosZ);
    camLook.set(desiredLookX, desiredLookY, desiredLookZ);
    camReady = true;
  } else {
    const camLerpRate = performance.now() < camRecenterBoostUntil ? 18 : 8;
    const camAlpha = 1 - Math.exp(-camLerpRate * dt);
    camDesiredPos.set(desiredPosX, desiredPosY, desiredPosZ);
    camDesiredLook.set(desiredLookX, desiredLookY, desiredLookZ);
    camPos.lerp(camDesiredPos, camAlpha);
    camLook.lerp(camDesiredLook, camAlpha);
  }
  camera.position.copy(camPos);
  camera.lookAt(camLook.x, camLook.y, camLook.z);
  camera.up.set(0, 1, 0);

  // cooldown HUD
  const now = performance.now();
  const statsNow = myAbilityStats();
  const qRemain = Math.max(0, qReadyAt - now);
  slotQMask.style.transform = `scaleY(${Math.max(0, Math.min(1, qRemain / Q_COOLDOWN_MS))})`;
  const wRemain = Math.max(0, wActiveUntil - now);
  slotWMask.style.transform = `scaleY(${Math.max(0, Math.min(1, wRemain / statsNow.wDuration))})`;
  if (wRemain > 0) {
    buffWIndicator.hidden = false;
    buffWIndicator.textContent = `Sprint ${Math.ceil(wRemain / 1000)}s`;
  } else {
    buffWIndicator.hidden = true;
  }
  const eRemain = Math.max(0, eReadyAt - now);
  slotEMask.style.transform = `scaleY(${Math.max(0, Math.min(1, eRemain / E_COOLDOWN_MS))})`;
  const rRemain = Math.max(0, rReadyAt - now);
  slotRMask.style.transform = `scaleY(${Math.max(0, Math.min(1, rRemain / R_COOLDOWN_MS))})`;
  const rCastRemain = Math.max(0, rCastUntil - now);
  if (rCastWrap && rCastFill) {
    if (alive && rCastRemain > 0) {
      rCastWrap.hidden = false;
      const k = 1 - Math.max(0, Math.min(1, rCastRemain / R_CAST_MS));
      rCastFill.style.width = `${Math.round(k * 100)}%`;
    } else {
      rCastWrap.hidden = true;
      rCastFill.style.width = '0%';
    }
  }

  // Grey out abilities if mana is insufficient.
  const canQ = alive && myMana >= Q_COST;
  const canW = alive && myMana >= W_COST && now >= wActiveUntil;
  const canE = alive && myMana >= E_COST;
  const canR = alive && myMana >= R_COST;
  slotQ.classList.toggle('disabled', !canQ);
  slotW.classList.toggle('disabled', !canW);
  slotE.classList.toggle('disabled', !canE);
  slotR.classList.toggle('disabled', !canR);
  if (!canQ && qMode) {
    qMode = false;
    slotQ.classList.remove('targeting');
  }
  if (!canE && teleportMode) {
    teleportMode = false;
    slotE.classList.remove('targeting');
  }
  if (!canR && rMode) {
    rMode = false;
    slotR.classList.remove('targeting');
  }

  // mana display (smoothly tween toward server-known + local prediction)
  if (me && typeof me.mana === 'number') {
    const maxMana = me.maxMana || startMana;
    // local regen prediction between snapshots (8/s)
    if (alive && myMana < maxMana) myMana = Math.min(maxMana, myMana + 8 * dt);
    mpText.textContent = `${Math.round(myMana)}/${maxMana}`;
    mpFill.style.width = `${Math.max(0, myMana) / maxMana * 100}%`;
  }

  drawMinimap();

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
