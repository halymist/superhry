// Arena client. Three.js + WebSocket. Client-authoritative movement & projectiles.
// Server only relays messages and tracks HP for consistent kills.

import * as THREE from 'three';

// ---------------- config ----------------
const MOVE_SPEED   = 7.2;   // u/s

// Q skillshot (Mystic Shot)
const Q_SPEED_START = 27.0;
const Q_SPEED_MAX   = 31.0;
const Q_ACCEL       = 0.0;
const Q_RANGE      = 19.0;
const Q_RADIUS     = 0.24;
const Q_BASE_DAMAGE = 8;
const Q_DAMAGE_STEP = 4;
const Q_COOLDOWN_MS = 5600;
const Q_COST       = 35;
const Q_BURST_MS = 760;
const Q_BURST_INTERVAL_MS = 130;

// Ranged auto-attack
const AA_SPEED_START = 14.0;
const AA_SPEED_MAX   = 24.0;
const AA_ACCEL       = 28.0;
const AA_RANGE     = 17.0;
const AA_RADIUS    = 0.28;
const AA_DAMAGE    = 24;
const AA_COOLDOWN_MS = 700;

// R ultimate (Trueshot Barrage)
const R_SPEED_START = 9.0;
const R_SPEED_MAX   = 36.0;
const R_ACCEL       = 18.0;
const R_RANGE      = 60.0;
const R_RADIUS     = 1.45;
const R_DAMAGE     = 100;
const R_DAMAGE_STEP = 30;
const R_COOLDOWN_MS = 2500;
const R_COST       = 75;
const R_CAST_MS    = 1000;

// C dash (Charge)
const C_COOLDOWN_MS = 7000;
const C_COST        = 40;
const C_DASH_DIST   = 10.2;

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
const HP_MANA_UP_MAX = 10;
const SPELL_UP_MAX = 5;
const C_DASH_MS     = 220;

// camera pan
const CAM_PAN_EDGE = 0.72;
const CAM_PAN_SPEED = 30.0;

// V pool
const V_COOLDOWN_MS = 13000;
const V_COST        = 55;
const V_DURATION_MS = 5000;
const V_BASE_RADIUS = 5.7;
const V_RADIUS_STEP = 0.22;

const X_COOLDOWN_MS = 9000;
const X_COST = 45;
const X_SPEED_START = 22.0;
const X_SPEED_MAX = 26.0;
const X_ACCEL = 0.0;
const X_RANGE = 22.0;
const X_RADIUS = 0.72;
const X_DAMAGE = 12;

const Z_COOLDOWN_MS = 3000;
const Z_COST = 50;
const Z_DELAY_MS = 700;
const Z_LINGER_MS = 2000;
const Z_TICK_MS = 250;
const Z_LINGER_DAMAGE_FACTOR = 0.125;
const Z_CAST_RANGE = 13.0;
const Z_BASE_RADIUS = 1.55;
const Z_RADIUS_STEP = 0.22;
const Z_BASE_DAMAGE = 42;
const Z_DAMAGE_STEP = 15;

const PLAYER_MODEL_COLORS = [0x58c7ff, 0xff7b7b, 0x7be39a, 0xffd26b];

const SPELL_DEFS = {
  q: { id: 'q', name: 'Salva' },
  w: { id: 'w', name: 'Sprint' },
  e: { id: 'e', name: 'Teleport' },
  r: { id: 'r', name: 'Strela' },
  c: { id: 'c', name: 'Naraz' },
  v: { id: 'v', name: 'Pole' },
  x: { id: 'x', name: 'Omraceni' },
  z: { id: 'z', name: 'Dopad' },
};

// pickups
const PICKUP_RADIUS = 0.6;
const DOG_MAX_HP = 120;
const NAMESTEK_MAX_HP = 320;
const REDITEL_MAX_HP = 720;
const CURDA_MAX_HP = 240;
const REDITEL_BEAM_WARN_MS = 700;
const REDITEL_BEAM_WARN_RANGE = 44.0;
const BUFF_DURATION_MS = 30000;

const INTERP_DELAY_MS = 120; // remote interpolation
const SEND_HZ = 20;

let vReadyAt = 0;
const chargeAnim = { active: false, startAt: 0, endAt: 0, fromX: 0, fromZ: 0, toX: 0, toZ: 0 };

function upgradeCost(kind, lvl) {
  void kind;
  void lvl;
  return 2;
}

function myAbilityStats() {
  return {
    qDmg: Q_BASE_DAMAGE + Math.max(0, (myUp.q || 1) - 1) * Q_DAMAGE_STEP,
    wDuration: W_DURATION_MS + myUp.w * 1200,
    eRange: E_RANGE + myUp.e * 1.1,
    rRadius: R_RADIUS + myUp.r * 0.32,
    rDmg: R_DAMAGE + myUp.r * R_DAMAGE_STEP,
  };
}

function refreshSpellbookUi() {
  if (!spellbookPanel) return;
  upHpEl.textContent = `${myUp.hp}/${HP_MANA_UP_MAX}`;
  upManaEl.textContent = `${myUp.mana}/${HP_MANA_UP_MAX}`;
  upQEl.textContent = `${myUp.q}/${SPELL_UP_MAX}`;
  upWEl.textContent = `${myUp.w}/${SPELL_UP_MAX}`;
  upEEl.textContent = `${myUp.e}/${SPELL_UP_MAX}`;
  upREl.textContent = `${myUp.r}/${SPELL_UP_MAX}`;
  upCEl.textContent = `${myUp.c}/${SPELL_UP_MAX}`;
  upVEl.textContent = `${myUp.v}/${SPELL_UP_MAX}`;
  upXEl.textContent = `${myUp.x}/${SPELL_UP_MAX}`;
  upZEl.textContent = `${myUp.z}/${SPELL_UP_MAX}`;
  const lvlByKind = { hp: myUp.hp, mana: myUp.mana, q: myUp.q, w: myUp.w, e: myUp.e, r: myUp.r, c: myUp.c, v: myUp.v, x: myUp.x, z: myUp.z };
  const capByKind = { hp: HP_MANA_UP_MAX, mana: HP_MANA_UP_MAX, q: SPELL_UP_MAX, w: SPELL_UP_MAX, e: SPELL_UP_MAX, r: SPELL_UP_MAX, c: SPELL_UP_MAX, v: SPELL_UP_MAX, x: SPELL_UP_MAX, z: SPELL_UP_MAX };
  for (const inline of spellbookUpgradeInline) {
    const kind = inline.dataset.upgrade;
    const lvl = lvlByKind[kind] || 0;
    const cost = upgradeCost(kind, lvl);
    const maxLvl = capByKind[kind] || SPELL_UP_MAX;
    inline.title = lvl >= maxLvl ? 'MAX' : `Cena: ${cost} Prémie`;
    inline.classList.toggle('disabled', lvl >= maxLvl || myGold < cost);
  }

  for (const card of spellCards) {
    const kind = card.dataset.spell;
    if (!kind) continue;
    const lvl = lvlByKind[kind] || 0;
    card.classList.toggle('locked', lvl <= 0);
    card.title = '';
  }

  renderEquippedSlots();
  if (goldText) goldText.textContent = String(myGold);
}

function poolRadiusForLevel(level) {
  return V_BASE_RADIUS + Math.max(0, level) * V_RADIUS_STEP;
}

function zRadiusForLevel(level) {
  return Z_BASE_RADIUS + Math.max(0, level) * Z_RADIUS_STEP;
}

function zDamageForLevel(level) {
  return Z_BASE_DAMAGE + Math.max(0, level) * Z_DAMAGE_STEP;
}

function spellRadiusForLevel(kind, level) {
  if (kind === 'q') return Q_RANGE;
  if (kind === 'e') return E_RANGE + Math.max(0, level) * 1.1;
  if (kind === 'r') return R_RANGE;
  if (kind === 'c') return C_DASH_DIST;
  if (kind === 'v') return poolRadiusForLevel(level);
  if (kind === 'x') return X_RANGE;
  if (kind === 'z') return Z_CAST_RANGE;
  return null;
}

function tryCastPool() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
  if ((myUp.v || 0) <= 0) return;
  const now = performance.now();
  if (now < vReadyAt) return;
  if (myMana < V_COST) return;

  vReadyAt = now + V_COOLDOWN_MS;
  myMana = Math.max(0, myMana - V_COST);
  spawnPoolEffect(myId, poolRadiusForLevel(myUp.v || 0), V_DURATION_MS);
  send({ type: 'cast', data: { kind: 'v' } });
}

// ---------------- DOM / modal ----------------
const nameModal = document.getElementById('name-modal');
const nameInput = document.getElementById('name-input');
const nameGo    = document.getElementById('name-go');
const charModelButtons = Array.from(document.querySelectorAll('.char-model'));
const activeBuffsEl = document.getElementById('active-buffs');
const buffStatusTextEl = document.getElementById('buff-status-text');

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
const spellbookPanel = document.getElementById('spellbook-panel');
const spellbookToggle = document.getElementById('spellbook-toggle');
const spellbookClose = document.getElementById('spellbook-close');
const respawnIndicator = document.getElementById('respawn-indicator');
const spellbookUpgradeInline = Array.from(document.querySelectorAll('#spellbook-panel .sb-upgrade'));
const spellCards = Array.from(document.querySelectorAll('#spellbook-panel .sb-spell'));
const upHpEl = document.getElementById('u-hp');
const upManaEl = document.getElementById('u-mana');
const upQEl = document.getElementById('u-q');
const upWEl = document.getElementById('u-w');
const upEEl = document.getElementById('u-e');
const upREl = document.getElementById('u-r');
const upCEl = document.getElementById('u-c');
const upVEl = document.getElementById('u-v');
const upXEl = document.getElementById('u-x');
const upZEl = document.getElementById('u-z');
const rCastWrap = document.getElementById('r-cast-wrap');
const rCastFill = document.getElementById('r-cast-fill');

const slotEls = { q: slotQ, w: slotW, e: slotE, r: slotR };
const slotMaskEls = { q: slotQMask, w: slotWMask, e: slotEMask, r: slotRMask };
const slotLabelEls = {
  q: slotQ?.querySelector('.label'),
  w: slotW?.querySelector('.label'),
  e: slotE?.querySelector('.label'),
  r: slotR?.querySelector('.label'),
};

const equippedBySlot = { q: 'q', w: null, e: null, r: null };

const BUFF_DEFS = {
  speed: { key: 'speed', label: 'Rychlost', desc: 'Rychlost pohybu +20%', color: '#4fc3ff' },
  hp: { key: 'hp', label: 'Životy', desc: 'Max. životy +20%', color: '#ff6e8a' },
  mana: { key: 'mana', label: 'Mana', desc: 'Max. mana +20%', color: '#6bb7ff' },
  dmg: { key: 'dmg', label: 'Poškození', desc: 'Poškození +10%', color: '#ff9b5c' },
};

function normalizeBuffKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return '';
  return k.startsWith('buff_') ? k.slice(5) : k;
}

const savedName = sessionStorage.getItem('superhry-name') || '';
const savedModelRaw = Number(sessionStorage.getItem('superhry-model') || '0');
let selectedModel = Number.isFinite(savedModelRaw) ? Math.max(0, Math.min(3, Math.trunc(savedModelRaw))) : 0;
nameInput.value = savedName;

let myName = '';

function modelColor(model) {
  const idx = Number.isFinite(model) ? Math.max(0, Math.min(3, Math.trunc(model))) : 0;
  return PLAYER_MODEL_COLORS[idx] || PLAYER_MODEL_COLORS[0];
}

function updateModelPickerUi() {
  for (const btn of charModelButtons) {
    const model = Number(btn.dataset.model || '0');
    btn.classList.toggle('active', model === selectedModel);
  }
}

function applyPlayerModelVisual(pl, model) {
  if (!pl || !pl.mesh) return;
  const normModel = Number.isFinite(model) ? Math.max(0, Math.min(3, Math.trunc(model))) : 0;
  const color = modelColor(normModel);
  pl.model = normModel;
  pl.color = color;
  const body = pl.mesh.children && pl.mesh.children[0];
  if (body && body.material) {
    if (body.material.color) body.material.color.setHex(color);
    if (body.material.emissive) body.material.emissive.setHex(color);
  }
}

for (const btn of charModelButtons) {
  btn.addEventListener('click', () => {
    const model = Number(btn.dataset.model || '0');
    if (!Number.isFinite(model)) return;
    selectedModel = Math.max(0, Math.min(3, Math.trunc(model)));
    updateModelPickerUi();
  });
}
updateModelPickerUi();

function startWithName() {
  const n = (nameInput.value || 'player').trim().slice(0, 16);
  myName = n || 'player';
  sessionStorage.setItem('superhry-name', myName);
  sessionStorage.setItem('superhry-model', String(selectedModel));
  nameModal.style.display = 'none';
  startGame();
}
nameGo.addEventListener('click', startWithName);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startWithName(); });

// ---------------- three.js setup ----------------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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

  const stunSp = makeStunSprite();
  stunSp.position.y = 2.9;
  stunSp.visible = false;
  g.add(stunSp);
  g.userData.stunSprite = stunSp;

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
  drawTalkSprite(ctx, text || '', 28);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(3.8, 0.72, 1);
  sp.userData.canvas = c;
  sp.userData.ctx = ctx;
  sp.userData.tex = tex;
  return sp;
}

function makeStunSprite() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8bf6ff';
  ctx.fillText('***', c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.1, 0.55, 1);
  sp.userData.tex = tex;
  return sp;
}
function drawTalkSprite(ctx, text, fontPx = 28) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!text) return;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, 6, 8, w - 12, h - 20, 10);
  ctx.fill();
  ctx.font = `bold ${fontPx}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8f7ff';
  ctx.fillText(text, w / 2, h / 2 - 2);
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
  const t = text || '';
  const c = sp.userData.canvas;
  const ctx = sp.userData.ctx;
  const fontPx = 28;
  const maxW = 1200;
  const minW = 140;
  ctx.font = `bold ${fontPx}px ui-monospace, Consolas, monospace`;
  const measured = t ? Math.ceil(ctx.measureText(t).width) : 0;
  const w = Math.max(minW, Math.min(maxW, measured + 44));
  const h = 76;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    sp.scale.set((w / 420) * 3.8, 0.72, 1);
  }
  drawTalkSprite(ctx, t, fontPx);
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
  const isSofie = n.kind === 'sofie';
  const isCurda = n.kind === 'curda';
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
  } else if (isSofie) {
    const dressMat = new THREE.MeshStandardMaterial({ color: 0x84b6ff, roughness: 0.58, metalness: 0.03, emissive: 0x335b95, emissiveIntensity: 0.16 });
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.46, 1.05, 16), dressMat);
    torso.position.y = 0.94;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 11), new THREE.MeshStandardMaterial({ color: 0xf2dccf, roughness: 0.64 }));
    head.position.set(0, 1.58, 0.2);
    g.add(head);
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x3f2217, roughness: 0.78 });
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 10), hairMat);
    hairCap.scale.set(1.04, 0.74, 1.05);
    hairCap.position.set(0, 1.72, 0.12);
    g.add(hairCap);
    const pony = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.55, 10), hairMat);
    pony.position.set(0, 1.48, -0.22);
    pony.rotation.x = 0.46;
    g.add(pony);
    const face = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 9),
      new THREE.MeshStandardMaterial({ color: 0xf8fbff, emissive: 0x8adfff, emissiveIntensity: 0.2 })
    );
    face.position.set(0, 1.58, 0.48);
    g.add(face);
  } else if (isCurda) {
    const coatMat = new THREE.MeshStandardMaterial({ color: 0xb4cc64, roughness: 0.56, metalness: 0.05, emissive: 0x4f5f28, emissiveIntensity: 0.2 });
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.45, 1.08, 16), coatMat);
    torso.position.y = 0.95;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 11), new THREE.MeshStandardMaterial({ color: 0xf0dccd, roughness: 0.66 }));
    head.position.set(0, 1.58, 0.2);
    g.add(head);
    const glasses = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.04), new THREE.MeshStandardMaterial({ color: 0x1d1f29, roughness: 0.4, metalness: 0.2 }));
    glasses.position.set(0, 1.59, 0.45);
    g.add(glasses);
    const phone = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.24, 0.03), new THREE.MeshStandardMaterial({ color: 0x2b2f3f, emissive: 0x141823, emissiveIntensity: 0.35 }));
    phone.position.set(0.26, 1.0, 0.35);
    phone.rotation.y = -0.6;
    g.add(phone);
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
  nameSp.position.y = isDog ? 1.65 : (isReditel ? 2.05 : 2.45);
  g.add(nameSp);

  if (isDog) {
    const hpSp = makeHpSprite();
    hpSp.position.y = 1.95;
    g.add(hpSp);
    g.userData.hpSprite = hpSp;
  } else if (isReditel) {
    const hpSp = makeHpSprite();
    hpSp.position.y = 2.35;
    g.add(hpSp);
    g.userData.hpSprite = hpSp;
  } else if (n.kind === 'namestek') {
    const hpSp = makeHpSprite();
    hpSp.position.y = 2.15;
    g.add(hpSp);
    g.userData.hpSprite = hpSp;
  } else if (isCurda) {
    const hpSp = makeHpSprite();
    hpSp.position.y = 2.15;
    g.add(hpSp);
    g.userData.hpSprite = hpSp;
  }

  const talkSp = makeTalkSprite('');
  talkSp.position.y = isDog ? 2.7 : (isCurda ? 3.5 : 3.75);
  talkSp.visible = false;
  g.add(talkSp);

  const stunSp = makeStunSprite();
  stunSp.position.y = isDog ? 2.25 : (isReditel ? 2.85 : (isCurda ? 3.0 : 3.1));
  stunSp.visible = false;
  g.add(stunSp);

  g.scale.setScalar(n.scale || 1);
  g.userData.nameSprite = nameSp;
  g.userData.talkSprite = talkSp;
  g.userData.stunSprite = stunSp;
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
      obj = { id: n.id, mesh, kind: n.kind, name: n.name, hp: n.hp || 0, maxHp: n.maxHp || 0, alive: n.alive !== false, say: '', sayUntil: 0, lastSay: '', stunUntil: 0 };
      npcs.set(n.id, obj);
    }
    obj.id = n.id;
    obj.kind = n.kind;
    obj.name = n.name;
    obj.hp = n.hp || 0;
    obj.maxHp = n.maxHp || 0;
    obj.alive = n.alive !== false;
    obj.mesh.position.set(n.x, 0, n.z);
    obj.mesh.rotation.y = n.facing || 0;
    obj.mesh.scale.setScalar(n.scale || 1);
    obj.mesh.visible = obj.alive;
    setNameSprite(obj.mesh.userData.nameSprite, n.name || n.kind, '#e6f2ff');
    if ((obj.kind === 'pes' || obj.kind === 'reditel' || obj.kind === 'namestek' || obj.kind === 'curda') && obj.mesh.userData.hpSprite) {
      const fallbackMax = obj.kind === 'reditel'
        ? REDITEL_MAX_HP
        : (obj.kind === 'namestek' ? NAMESTEK_MAX_HP : (obj.kind === 'curda' ? CURDA_MAX_HP : DOG_MAX_HP));
      const maxHp = obj.maxHp > 0 ? obj.maxHp : fallbackMax;
      setHpSprite(obj.mesh.userData.hpSprite, obj.hp, maxHp);
      obj.mesh.userData.hpSprite.visible = obj.alive;
    }
    obj.say = n.say || '';
    obj.sayUntil = n.sayUntil || 0;
    obj.stunUntil = n.stunUntil || 0;
    if (!obj.say) {
      obj.lastSay = '';
    } else if (obj.say !== obj.lastSay) {
      setTalkSprite(obj.mesh.userData.talkSprite, obj.say);
      obj.lastSay = obj.say;
    }
    if (obj.mesh.userData.stunSprite) {
      obj.mesh.userData.stunSprite.visible = obj.alive && Date.now() < obj.stunUntil;
    }
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
    const stunSp = n.mesh.userData.stunSprite;
    if (stunSp) {
      stunSp.visible = n.alive && nowMs < (n.stunUntil || 0);
    }
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
let myUp = { hp: 0, mana: 0, q: 1, w: 0, e: 0, r: 0, c: 0, v: 0, x: 0, z: 0 };
let myStunUntil = 0;
const myBuffs = new Map();

const players = new Map(); // id -> { mesh, name, hp, alive, snapshots: [{t,x,z,facing}], lastSeen }
const projectiles = []; // {pid, owner, x, z, vx, vz, dist, max, mesh, hitDone}
const pickups = new Map(); // id -> { kind, x, z, mesh }
const npcs = new Map(); // id -> { mesh, kind, name, say, sayUntil }
const beamWarnings = [];
const activePools = [];
const activeGroundBursts = [];
const projectileTargets = [];
const projectileDogTargets = [];
const projectileBlockers = [];

let myProjectileSeq = 1;
let qReadyAt = 0;
let qBurstUntil = 0;
let qBurstNextShotAt = 0;
let wActiveUntil = 0;
let eReadyAt = 0;
let rReadyAt = 0;
let cReadyAt = 0;
let xReadyAt = 0;
let zReadyAt = 0;
let aaReadyAt = 0;
let rCastUntil = 0;
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

const slotRadiusPreviewMat = new THREE.MeshBasicMaterial({ color: 0x9ee7ff, transparent: true, opacity: 0.62, side: THREE.DoubleSide });
const slotRadiusPreview = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 72), slotRadiusPreviewMat);
slotRadiusPreview.rotation.x = -Math.PI / 2;
slotRadiusPreview.position.y = 0.065;
slotRadiusPreview.visible = false;
scene.add(slotRadiusPreview);
let hoveredSlotKey = null;

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
    send({ type: 'join', data: { name: myName, model: selectedModel } });
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
      myUp = { hp: 0, mana: 0, q: 1, w: 0, e: 0, r: 0, c: 0, v: 0, x: 0, z: 0 };
      myStunUntil = 0;
      refreshSpellbookUi();
      break;

    case 'snap':
      handleSnapshot(m.data);
      break;

    case 'fire':
      if (m.data.kind === 'pool_cast') {
        spawnPoolEffect(m.data.owner, m.data.dx || V_BASE_RADIUS, (m.data.dz || 5) * 1000);
        break;
      }
      if (m.data.kind === 'reditel_beam_warn') {
        spawnBeamWarning(m.data);
        break;
      }
      if (m.data.kind === 'z') {
        if (m.data.owner !== myId) {
          spawnGroundBurst(m.data.owner, m.data.ox, m.data.oz, m.data.dx || Z_BASE_RADIUS, (m.data.dz || (Z_DELAY_MS / 1000)) * 1000, 0);
        }
        break;
      }
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
      const color = modelColor(p.model || 0);
      const mesh = makeBody(color);
      scene.add(mesh);
      pl = { mesh, name: p.name, hp: p.hp, mana: p.mana, alive: p.alive, snapshots: [], color, model: p.model || 0 };
      players.set(p.id, pl);
      setNameSprite(mesh.userData.nameSprite, p.name, '#e6e8ee');
    }
    const snapModel = Number.isFinite(p.model) ? Math.max(0, Math.min(3, Math.trunc(p.model))) : 0;
    if (pl.model !== snapModel) {
      applyPlayerModelVisual(pl, snapModel);
    }
    if (pl.name !== p.name) {
      pl.name = p.name;
      setNameSprite(pl.mesh.userData.nameSprite, p.name, '#e6e8ee');
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
    pl.upC = p.upC || 0;
    pl.upV = p.upV || 0;
    pl.upX = p.upX || 0;
    pl.upZ = p.upZ || 0;
    pl.buffs = Array.isArray(p.buffs) ? p.buffs : [];
    pl.stunUntil = p.stunUntil || 0;
    pl.respawnAt = p.respawnAt || 0;
    pl.alive = p.alive;
    if (pl.mesh.userData.hpSprite) {
      setHpSprite(pl.mesh.userData.hpSprite, p.hp, pl.maxHp);
      pl.mesh.userData.hpSprite.visible = p.id !== myId && p.alive;
    }
    if (pl.mesh.userData.stunSprite) {
      pl.mesh.userData.stunSprite.visible = p.alive && Date.now() < pl.stunUntil;
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
      c: me.upC || 0,
      v: me.upV || 0,
      x: me.upX || 0,
      z: me.upZ || 0,
    };
    setMyBuffs(me.buffs || []);
    myStunUntil = me.stunUntil || 0;
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
  return modelColor(id % PLAYER_MODEL_COLORS.length);
}

function setMyBuffs(buffs) {
  myBuffs.clear();
  const now = Date.now();
  for (const b of buffs || []) {
    if (!b) continue;
    const kind = normalizeBuffKind(b.kind);
    if (!kind) continue;
    const until = Number(b.until) || 0;
    if (until > now) myBuffs.set(kind, until);
  }
}

function hasMyBuff(kind) {
  const until = myBuffs.get(normalizeBuffKind(kind)) || 0;
  return until > Date.now();
}

function updateActiveBuffIcons(nowMs) {
  const entries = [];
  for (const [kind, until] of myBuffs.entries()) {
    if (until > nowMs) entries.push({ kind, until });
  }
  entries.sort((a, b) => a.until - b.until);

  const seen = new Set(entries.map(e => e.kind));
  for (const kind of Array.from(myBuffs.keys())) {
    if (!seen.has(kind)) myBuffs.delete(kind);
  }

  if (buffStatusTextEl) {
    if (entries.length === 0) {
      buffStatusTextEl.textContent = 'Žádné aktivní efekty';
    } else {
      buffStatusTextEl.textContent = entries
        .map(e => {
          const def = BUFF_DEFS[e.kind];
          const secs = Math.ceil(Math.max(0, e.until - nowMs) / 1000);
          if (!def) return `${e.kind}: ${secs}s`;
          return `${def.label}: ${secs}s`;
        })
        .join(' | ');
    }
  }

  if (!activeBuffsEl) return;

  activeBuffsEl.textContent = '';
  for (const e of entries) {
    const def = BUFF_DEFS[e.kind];
    if (!def) continue;
    const remainMS = Math.max(0, e.until - nowMs);
    const ratio = Math.max(0, Math.min(1, remainMS / BUFF_DURATION_MS));
    const secs = Math.ceil(remainMS / 1000);

    const row = document.createElement('div');
    row.className = 'buff-row';
    row.title = `${def.label}: ${def.desc}`;

    const fill = document.createElement('div');
    fill.className = 'buff-row-fill';
    fill.style.background = def.color;
    fill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;

    const text = document.createElement('div');
    text.className = 'buff-row-text';
    text.textContent = `${def.label} (${secs}s)`;

    row.appendChild(fill);
    row.appendChild(text);
    activeBuffsEl.appendChild(row);
  }
}

function isSpellUnlocked(kind) {
  return (myUp[kind] || 0) > 0;
}

function equipSpellToSlot(spellKind, slotKey) {
  for (const k of Object.keys(equippedBySlot)) {
    if (equippedBySlot[k] === spellKind) equippedBySlot[k] = null;
  }
  equippedBySlot[slotKey] = spellKind;
  renderEquippedSlots();
}

function renderEquippedSlots() {
  for (const slotKey of Object.keys(slotEls)) {
    const el = slotEls[slotKey];
    const labelEl = slotLabelEls[slotKey];
    const spellKind = equippedBySlot[slotKey];
    const def = spellKind ? SPELL_DEFS[spellKind] : null;
    if (labelEl) labelEl.textContent = def ? def.name : 'Prázdné';
    if (!el) continue;
    el.classList.toggle('active', !!def);
    el.classList.toggle('empty', !def);
  }
}

function castEquipped(slotKey) {
  const spellKind = equippedBySlot[slotKey];
  if (!spellKind) return;
  if (spellKind === 'q') {
    tryFireQ();
    return;
  }
  if (spellKind === 'w') {
    tryCastW();
    return;
  }
  if (spellKind === 'e') {
    updateMouseWorld();
    tryTeleport();
    return;
  }
  if (spellKind === 'r') {
    tryFireR();
    return;
  }
  if (spellKind === 'c') {
    tryCastCharge();
    return;
  }
  if (spellKind === 'v') {
    tryCastPool();
    return;
  }
  if (spellKind === 'x') {
    tryFireX();
    return;
  }
  if (spellKind === 'z') {
    tryCastZ();
  }
}

function spellCooldownRatio(kind, now, statsNow) {
  if (kind === 'q') return Math.max(0, Math.min(1, Math.max(0, qReadyAt - now) / Q_COOLDOWN_MS));
  if (kind === 'w') return Math.max(0, Math.min(1, Math.max(0, wActiveUntil - now) / Math.max(1, statsNow.wDuration)));
  if (kind === 'e') return Math.max(0, Math.min(1, Math.max(0, eReadyAt - now) / E_COOLDOWN_MS));
  if (kind === 'r') return Math.max(0, Math.min(1, Math.max(0, rReadyAt - now) / R_COOLDOWN_MS));
  if (kind === 'c') return Math.max(0, Math.min(1, Math.max(0, cReadyAt - now) / C_COOLDOWN_MS));
  if (kind === 'v') return Math.max(0, Math.min(1, Math.max(0, vReadyAt - now) / V_COOLDOWN_MS));
  if (kind === 'x') return Math.max(0, Math.min(1, Math.max(0, xReadyAt - now) / X_COOLDOWN_MS));
  if (kind === 'z') return Math.max(0, Math.min(1, Math.max(0, zReadyAt - now) / Z_COOLDOWN_MS));
  return 0;
}

function canCastSpell(kind, alive, now) {
  if (!alive || !kind) return false;
  if (Date.now() < myStunUntil) return false;
  if (kind === 'q') return myMana >= Q_COST && now >= qReadyAt && now >= qBurstUntil;
  if (kind === 'w') return myMana >= W_COST && now >= wActiveUntil;
  if (kind === 'e') return myMana >= E_COST && now >= eReadyAt;
  if (kind === 'r') return myMana >= R_COST && now >= rReadyAt && now >= rCastUntil;
  if (kind === 'c') return myUp.c > 0 && myMana >= C_COST && now >= cReadyAt;
  if (kind === 'v') return myUp.v > 0 && myMana >= V_COST && now >= vReadyAt;
  if (kind === 'x') return myUp.x > 0 && myMana >= X_COST && now >= xReadyAt;
  if (kind === 'z') return myUp.z > 0 && myMana >= Z_COST && now >= zReadyAt;
  return false;
}

// ---------------- input ----------------
window.addEventListener('keydown', e => {
  if (nameModal.style.display !== 'none') return;
  if (e.code === 'KeyQ') {
    e.preventDefault();
    castEquipped('q');
  } else if (e.code === 'KeyW') {
    e.preventDefault();
    castEquipped('w');
  } else if (e.code === 'KeyE') {
    e.preventDefault();
    castEquipped('e');
  } else if (e.code === 'KeyR') {
    e.preventDefault();
    castEquipped('r');
  } else if (e.code === 'KeyB') {
    e.preventDefault();
    spellbookPanel.hidden = !spellbookPanel.hidden;
  } else if (e.code === 'Space') {
    e.preventDefault();
    centerCameraOnMe();
  } else if (e.code === 'Escape') {
    clearAbilityModes();
  }
});

slotQ.addEventListener('click', () => castEquipped('q'));
slotW.addEventListener('click', () => castEquipped('w'));
slotE.addEventListener('click', () => castEquipped('e'));
slotR.addEventListener('click', () => castEquipped('r'));

spellbookToggle?.addEventListener('click', () => {
  spellbookPanel.hidden = !spellbookPanel.hidden;
});

spellbookClose?.addEventListener('click', () => {
  spellbookPanel.hidden = true;
});

for (const inline of spellbookUpgradeInline) {
  inline.addEventListener('click', () => {
    const kind = inline.dataset.upgrade;
    if (!kind) return;
    const lvl = myUp[kind] || 0;
    const maxLvl = (kind === 'hp' || kind === 'mana') ? HP_MANA_UP_MAX : SPELL_UP_MAX;
    if (lvl >= maxLvl) return;
    if (myGold < upgradeCost(kind, lvl)) return;
    send({ type: 'upgrade', data: { kind } });
  });
}

for (const card of spellCards) {
  card.addEventListener('click', () => {
    const kind = card.dataset.spell;
    if (!kind || !(kind in SPELL_DEFS)) return;
    send({ type: 'upgrade', data: { kind } });
  });
  card.addEventListener('dragstart', e => {
    const kind = card.dataset.spell;
    if (!kind || !isSpellUnlocked(kind)) {
      e.preventDefault();
      return;
    }
    card.classList.add('dragging');
    e.dataTransfer?.setData('text/spell-kind', kind);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
}

for (const slotKey of Object.keys(slotEls)) {
  const slotEl = slotEls[slotKey];
  if (!slotEl) continue;
  slotEl.addEventListener('mouseenter', () => { hoveredSlotKey = slotKey; });
  slotEl.addEventListener('mouseleave', () => { if (hoveredSlotKey === slotKey) hoveredSlotKey = null; });
  slotEl.addEventListener('dragover', e => {
    e.preventDefault();
    slotEl.classList.add('drag-over');
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
  slotEl.addEventListener('drop', e => {
    e.preventDefault();
    slotEl.classList.remove('drag-over');
    const spellKind = e.dataTransfer?.getData('text/spell-kind');
    if (!spellKind || !(spellKind in SPELL_DEFS) || !isSpellUnlocked(spellKind)) return;
    equipSpellToSlot(spellKind, slotKey);
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
    if (qMode) {
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
  cReadyAt = 0;
  vReadyAt = 0;
  xReadyAt = 0;
  zReadyAt = 0;
  myStunUntil = 0;
  chargeAnim.active = false;
  qMode = false;
  rMode = false;
  blink.active = false;
  camReady = false;
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
  rMode = false;
  slotQ.classList.remove('targeting');
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
  if (rMode)        { rMode = false;        slotR.classList.remove('targeting'); }
}

function tryEnterRMode() {
  tryFireR();
}

function tryCastW() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
  const now = performance.now();
  if (now < wActiveUntil) return;
  if (myMana < W_COST) return;
  const stats = myAbilityStats();
  wActiveUntil = now + stats.wDuration;
  myMana = Math.max(0, myMana - W_COST);
  send({ type: 'cast', data: { kind: 'w' } });
}

function tryTeleport() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
  const now = performance.now();
  if (now < eReadyAt) return;
  if (myMana < E_COST) return;

  let dx;
  let dz;
  if (hasMouse) {
    dx = mouseWorld.x - myPos.x;
    dz = mouseWorld.z - myPos.z;
  } else {
    dx = Math.sin(myFacing);
    dz = Math.cos(myFacing);
  }
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) return;

  const ux = dx / dist, uz = dz / dist;
  const stats = myAbilityStats();
  const want = Math.min(stats.eRange, dist);
  const targetX = myPos.x + ux * want;
  const targetZ = myPos.z + uz * want;
  const spot = findTeleportSpot(targetX, targetZ, Math.max(2.8, PLAYER_RADIUS + 1.9));
  if (!spot) return;

  myPos.x = spot.x;
  myPos.z = spot.z;
  hasMoveTarget = false;

  eReadyAt = now + E_COOLDOWN_MS;
  myMana = Math.max(0, myMana - E_COST);

  blink.active = true;
  blink.start = now;

  send({ type: 'cast', data: { kind: 'e' } });
  send({ type: 'state', data: { x: myPos.x, z: myPos.z, facing: myFacing } });
}

// ---------------- projectiles ----------------
function tryFireQ() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
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
  if (Date.now() < myStunUntil) return;
  const now = performance.now();
  if (now < rReadyAt) return;
  if (rCastUntil > now) return;
  if (myMana < R_COST) return;

  // R cast roots the player immediately when triggered.
  hasMoveTarget = false;
  rightMouseDown = false;
  myVel.set(0, 0);

  rReadyAt = now + R_COOLDOWN_MS;
  rCastUntil = now + R_CAST_MS;
  myMana = Math.max(0, myMana - R_COST);
  rMode = false;
  slotR.classList.remove('targeting');
}

function tryCastCharge() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
  if ((myUp.c || 0) <= 0) return;
  const now = performance.now();
  if (now < cReadyAt) return;
  if (myMana < C_COST) return;

  const dirX = Math.sin(myFacing);
  const dirZ = Math.cos(myFacing);
  const end = segmentEndpoint(myPos.x, myPos.z, dirX, dirZ, C_DASH_DIST, PLAYER_RADIUS);

  chargeAnim.active = true;
  chargeAnim.startAt = now;
  chargeAnim.endAt = now + C_DASH_MS;
  chargeAnim.fromX = myPos.x;
  chargeAnim.fromZ = myPos.z;
  chargeAnim.toX = Math.max(-serverHalfX, Math.min(serverHalfX, end.x));
  chargeAnim.toZ = Math.max(-serverHalfZ, Math.min(serverHalfZ, end.z));

  hasMoveTarget = false;
  rightMouseDown = false;
  myVel.set(0, 0);

  cReadyAt = now + C_COOLDOWN_MS;
  myMana = Math.max(0, myMana - C_COST);
  send({ type: 'cast', data: { kind: 'c' } });
  send({ type: 'state', data: { x: chargeAnim.toX, z: chargeAnim.toZ, facing: myFacing } });
}

function tryFireX() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
  if ((myUp.x || 0) <= 0) return;
  const now = performance.now();
  if (now < xReadyAt) return;
  if (myMana < X_COST) return;

  xReadyAt = now + X_COOLDOWN_MS;
  myMana = Math.max(0, myMana - X_COST);
  fireProjectile('x');
}

function tryCastZ() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
  if ((myUp.z || 0) <= 0) return;
  const now = performance.now();
  if (now < zReadyAt) return;
  if (myMana < Z_COST) return;

  updateMouseWorld();
  let tx = myPos.x + Math.sin(myFacing) * 3.5;
  let tz = myPos.z + Math.cos(myFacing) * 3.5;
  if (hasMouse) {
    tx = mouseWorld.x;
    tz = mouseWorld.z;
  }
  {
    const dx = tx - myPos.x;
    const dz = tz - myPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > Z_CAST_RANGE && dist > 0.001) {
      tx = myPos.x + (dx / dist) * Z_CAST_RANGE;
      tz = myPos.z + (dz / dist) * Z_CAST_RANGE;
    }
  }
  tx = Math.max(-serverHalfX + 0.5, Math.min(serverHalfX - 0.5, tx));
  tz = Math.max(-serverHalfZ + 0.5, Math.min(serverHalfZ - 0.5, tz));

  const radius = zRadiusForLevel(myUp.z || 0);
  const damage = zDamageForLevel(myUp.z || 0);
  zReadyAt = now + Z_COOLDOWN_MS;
  myMana = Math.max(0, myMana - Z_COST);

  spawnGroundBurst(myId, tx, tz, radius, Z_DELAY_MS, damage);
  send({ type: 'fire', data: { pid: myProjectileSeq++, ox: tx, oz: tz, dx: radius, dz: Z_DELAY_MS / 1000, kind: 'z' } });
}

function tryAutoAttack() {
  const me = players.get(myId);
  if (!me || !me.alive) return;
  if (Date.now() < myStunUntil) return;
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
  const b = boost || { qDmg: Q_BASE_DAMAGE, rRadius: R_RADIUS, rDmg: R_DAMAGE };
  switch (kind) {
    case 'reditel':
      return { radius: 0.22, startSpeed: 12.0, maxSpeed: 12.0, accel: 0, range: 10.0, dmg: 9, pierce: true };
    case 'reditel_beam':
      return { radius: 0.92, startSpeed: 78.0, maxSpeed: 78.0, accel: 0, range: 44.0, dmg: 80, pierce: true };
    case 'r':
      return { radius: b.rRadius, startSpeed: R_SPEED_START, maxSpeed: R_SPEED_MAX, accel: R_ACCEL, range: R_RANGE, dmg: b.rDmg, pierce: true };
    case 'aa':
      return { radius: AA_RADIUS, startSpeed: AA_SPEED_START, maxSpeed: AA_SPEED_MAX, accel: AA_ACCEL, range: AA_RANGE, dmg: AA_DAMAGE, pierce: false };
    case 'x':
      return { radius: X_RADIUS, startSpeed: X_SPEED_START, maxSpeed: X_SPEED_MAX, accel: X_ACCEL, range: X_RANGE, dmg: X_DAMAGE, pierce: false };
    case 'curda_stun':
      return { radius: 0.60, startSpeed: 22.0, maxSpeed: 22.0, accel: 0, range: 18.0, dmg: 14, pierce: false };
    case 'curda_salva':
      return { radius: 0.30, startSpeed: 24.0, maxSpeed: 24.0, accel: 0, range: 16.0, dmg: 8, pierce: false };
    default:
      return { radius: Q_RADIUS, startSpeed: Q_SPEED_START, maxSpeed: Q_SPEED_MAX, accel: Q_ACCEL, range: Q_RANGE, dmg: b.qDmg, pierce: false };
  }
}

function spawnProjectile(p) {
  const kind = p.kind || 'q';
  const spec = projectileSpec(kind, p.boost || null);
  let color;
  if (kind === 'reditel') color = 0xffc46b;
  else if (kind === 'reditel_beam') color = 0xff6d8a;
  else if (kind === 'curda_stun') color = 0x8b7cff;
  else if (kind === 'curda_salva') color = 0xffb06b;
  else if (kind === 'r')      color = p.owner === myId ? 0xff7df6 : 0xff5dc8;
  else if (kind === 'x') color = p.owner === myId ? 0x89ffde : 0x7dcfff;
  else if (kind === 'aa') color = p.owner === myId ? 0xa6f0ff : 0xfff0a0;
  else                    color = p.owner === myId ? 0xffe48a : 0xff9b66;

  const geom = (kind === 'x' || kind === 'curda_stun')
    ? new THREE.BoxGeometry(1.2, 0.4, 0.4)
    : new THREE.SphereGeometry(spec.radius, 12, 9);
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: (kind === 'r' || kind === 'reditel_beam') ? 1.1 : 0.85 })
  );
  mesh.position.set(p.ox, 1.0, p.oz);
  if (kind === 'x' || kind === 'curda_stun') {
    mesh.rotation.y = Math.atan2(p.dx, p.dz);
  }
  scene.add(mesh);

  if (kind === 'r' || kind === 'reditel_beam') {
    const light = new THREE.PointLight(color, 1.3, 7);
    mesh.add(light);
  }

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

function spawnBeamWarning(p) {
  const sx = p.ox;
  const sz = p.oz;
  const ex = sx + p.dx * REDITEL_BEAM_WARN_RANGE;
  const ez = sz + p.dz * REDITEL_BEAM_WARN_RANGE;
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(sx, 0.11, sz),
      new THREE.Vector3(ex, 0.11, ez),
    ]),
    new THREE.LineBasicMaterial({ color: 0xff7f9f, transparent: true, opacity: 0.9 })
  );
  scene.add(line);
  beamWarnings.push({ line, startAt: performance.now(), endAt: performance.now() + REDITEL_BEAM_WARN_MS });
}

function updateBeamWarnings(now) {
  for (let i = beamWarnings.length - 1; i >= 0; i--) {
    const w = beamWarnings[i];
    if (now >= w.endAt) {
      scene.remove(w.line);
      w.line.geometry.dispose();
      w.line.material.dispose();
      beamWarnings.splice(i, 1);
      continue;
    }
    const k = (now - w.startAt) / Math.max(1, w.endAt - w.startAt);
    w.line.material.opacity = 0.95 - 0.55 * k;
  }
}

function spawnPoolEffect(ownerId, radius, durationMS) {
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({ color: 0x76ffd1, transparent: true, opacity: 0.34, side: THREE.DoubleSide })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.06;
  scene.add(disc);
  activePools.push({ ownerId, ring: disc, startAt: performance.now(), endAt: performance.now() + durationMS });
}

function updatePools(now) {
  for (let i = activePools.length - 1; i >= 0; i--) {
    const p = activePools[i];
    if (now >= p.endAt) {
      scene.remove(p.ring);
      p.ring.geometry.dispose();
      p.ring.material.dispose();
      activePools.splice(i, 1);
      continue;
    }
    const owner = players.get(p.ownerId);
    if (p.ownerId === myId) {
      p.ring.position.x = myPos.x;
      p.ring.position.z = myPos.z;
    } else if (owner) {
      p.ring.position.x = owner.mesh.position.x;
      p.ring.position.z = owner.mesh.position.z;
    }
    const t = (now - p.startAt) * 0.01;
    p.ring.material.opacity = 0.32 + 0.13 * (0.5 + 0.5 * Math.sin(t));
  }
}

function spawnGroundBurst(ownerId, x, z, radius, delayMS, damage) {
  const telegraph = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.1, radius - 0.07), radius, 48),
    new THREE.MeshBasicMaterial({ color: 0xffb37a, transparent: true, opacity: 0.92, side: THREE.DoubleSide })
  );
  telegraph.rotation.x = -Math.PI / 2;
  telegraph.position.set(x, 0.08, z);
  scene.add(telegraph);

  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({ color: 0xff5f44, transparent: true, opacity: 0.0, side: THREE.DoubleSide })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(x, 0.07, z);
  pool.visible = false;
  scene.add(pool);

  const now = performance.now();

  activeGroundBursts.push({
    ownerId,
    x,
    z,
    radius,
    damage,
    startAt: now,
    detonateAt: now + delayMS,
    lingerUntil: now + delayMS + Z_LINGER_MS,
    nextTickAt: now + delayMS,
    endAt: now + delayMS + Z_LINGER_MS,
    telegraph,
    pool,
    exploded: false,
  });
}

function applyGroundBurstDamage(x, z, radius, damage) {
  if (damage <= 0) return;
  for (const t of projectileTargets) {
    if (t.id === myId) continue;
    const dx = t.x - x;
    const dz = t.z - z;
    if (dx * dx + dz * dz <= (radius + PLAYER_RADIUS) ** 2) {
      send({ type: 'hit', data: { pid: 0, target: t.id, dmg: damage } });
    }
  }
  for (const n of projectileDogTargets) {
    const dx = n.x - x;
    const dz = n.z - z;
    if (dx * dx + dz * dz <= (radius + n.rad) ** 2) {
      send({ type: 'hit', data: { pid: 0, target: n.id, dmg: damage } });
    }
  }
}

function updateGroundBursts(now) {
  for (let i = activeGroundBursts.length - 1; i >= 0; i--) {
    const b = activeGroundBursts[i];
    if (!b.exploded && now >= b.detonateAt) {
      b.exploded = true;
      scene.remove(b.telegraph);
      b.telegraph.geometry.dispose();
      b.telegraph.material.dispose();
      b.pool.visible = true;
      b.pool.material.opacity = 0.66;
      if (b.ownerId === myId && b.damage > 0) {
        applyGroundBurstDamage(b.x, b.z, b.radius, b.damage);
      }
      b.nextTickAt = now + Z_TICK_MS;
    }

    if (b.exploded) {
      if (b.ownerId === myId && b.damage > 0 && now < b.lingerUntil) {
        const dot = Math.max(1, Math.round(b.damage * Z_LINGER_DAMAGE_FACTOR));
        while (now >= b.nextTickAt && b.nextTickAt < b.lingerUntil) {
          applyGroundBurstDamage(b.x, b.z, b.radius, dot);
          b.nextTickAt += Z_TICK_MS;
        }
      }
      const left = Math.max(0, Math.min(1, (b.endAt - now) / Math.max(1, Z_LINGER_MS)));
      b.pool.material.opacity = 0.24 + 0.42 * left;
      b.pool.material.color.setHex(0xff5f44);
    } else {
      const pre = Math.max(0, Math.min(1, (b.detonateAt - now) / Math.max(1, b.detonateAt - b.startAt)));
      b.telegraph.material.opacity = 0.34 + 0.58 * (1 - pre);
    }

    if (now >= b.endAt) {
      if (b.telegraph.parent) {
        scene.remove(b.telegraph);
        b.telegraph.geometry.dispose();
        b.telegraph.material.dispose();
      }
      scene.remove(b.pool);
      b.pool.geometry.dispose();
      b.pool.material.dispose();
      activeGroundBursts.splice(i, 1);
    }
  }
}

function updateSlotRadiusPreview(alive) {
  if (!alive || !hoveredSlotKey) {
    slotRadiusPreview.visible = false;
    return;
  }
  const kind = equippedBySlot[hoveredSlotKey];
  if (!kind) {
    slotRadiusPreview.visible = false;
    return;
  }
  const level = myUp[kind] || 0;
  const radius = spellRadiusForLevel(kind, level);
  if (radius == null || radius <= 0) {
    slotRadiusPreview.visible = false;
    return;
  }
  slotRadiusPreview.visible = true;
  slotRadiusPreview.position.set(myPos.x, 0.065, myPos.z);
  slotRadiusPreview.scale.setScalar(radius);
}

function refreshProjectileCollisionTargets() {
  projectileTargets.length = 0;
  projectileDogTargets.length = 0;
  projectileBlockers.length = 0;

  for (const [id, pl] of players) {
    if (!pl.alive) continue;
    projectileTargets.push({ id, x: pl.mesh.position.x, z: pl.mesh.position.z });
  }

  for (const [nid, n] of npcs) {
    if (!n.alive) continue;
    if (n.kind === 'pes' || n.kind === 'reditel' || n.kind === 'namestek' || n.kind === 'curda') {
      const rad = n.kind === 'reditel' ? 1.05 : (n.kind === 'namestek' ? 0.72 : (n.kind === 'curda' ? 0.72 : 0.6));
      projectileDogTargets.push({ id: Number(nid), x: n.mesh.position.x, z: n.mesh.position.z, rad });
    } else {
      projectileBlockers.push({ id: Number(nid), x: n.mesh.position.x, z: n.mesh.position.z, rad: 0.72 });
    }
  }
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
    for (const n of projectileBlockers) {
      if (n.id === pr.owner) continue;
      const dxn = n.x - pr.x;
      const dzn = n.z - pr.z;
      const nRad = n.rad;
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
      for (const target of projectileTargets) {
        if (target.id === myId) continue;
        if (pr.hitSet.has(target.id)) continue;
        const tx = target.x;
        const tz = target.z;
        const dx = tx - pr.x, dz = tz - pr.z;
        const extra = pr.kind === 'r' ? 0.35 : 0.0;
        if (dx * dx + dz * dz <= (pr.radius + PLAYER_RADIUS + extra) ** 2) {
          pr.hitSet.add(target.id);
          send({ type: 'hit', data: { pid: pr.pid, target: target.id, dmg: pr.dmg } });
          if (!pr.pierce) {
            disposeProjectile(i);
            break;
          }
        }
      }
      for (const n of projectileDogTargets) {
        const nk = `n${n.id}`;
        if (pr.hitSet.has(nk)) continue;
        const tx = n.x;
        const tz = n.z;
        const dx = tx - pr.x;
        const dz = tz - pr.z;
        const npcRadius = n.rad;
        if (dx * dx + dz * dz <= (pr.radius + npcRadius) ** 2) {
          pr.hitSet.add(nk);
          send({ type: 'hit', data: { pid: pr.pid, target: n.id, dmg: pr.dmg } });
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
  const colorByKind = {
    hp: 0xff5d8c,
    mana: 0x56d9ff,
    gold: 0xffd45b,
    buff_speed: 0x4fc3ff,
    buff_hp: 0xff6e8a,
    buff_mana: 0x6bb7ff,
    buff_dmg: 0xff9b5c,
  };
  const color = colorByKind[pk.kind] || (isHP ? 0xff5d8c : (isGold ? 0xffd45b : 0x56d9ff));
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

  const buffIconByKind = {
    buff_speed: 'Rychlost',
    buff_hp: 'Životy',
    buff_mana: 'Mana',
    buff_dmg: 'Poškození',
  };
  if (buffIconByKind[pk.kind]) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
    ctx.fillRect(8, 10, c.width - 16, c.height - 20);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeRect(8.5, 10.5, c.width - 17, c.height - 21);
    ctx.font = 'bold 22px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f6fbff';
    ctx.fillText(buffIconByKind[pk.kind], c.width / 2, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(1.25, 0.62, 1);
    sp.position.set(0, 1.02, 0);
    g.add(sp);
  }
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
    const stunned = Date.now() < myStunUntil;
    if (chargeAnim.active) {
      const nowMs = performance.now();
      const k = Math.max(0, Math.min(1, (nowMs - chargeAnim.startAt) / Math.max(1, chargeAnim.endAt - chargeAnim.startAt)));
      myPos.x = chargeAnim.fromX + (chargeAnim.toX - chargeAnim.fromX) * k;
      myPos.z = chargeAnim.fromZ + (chargeAnim.toZ - chargeAnim.fromZ) * k;
      hasMoveTarget = false;
      myVel.set(0, 0);
      if (k >= 1) chargeAnim.active = false;
    }

    const sprintActive = performance.now() < wActiveUntil;
    const speedBuffMult = hasMyBuff('speed') ? 1.1 : 1.0;
    const moveSpeedNow = MOVE_SPEED * speedBuffMult * (sprintActive ? W_SPEED_MULT : 1);
    myVel.set(0, 0);
    if (stunned) {
      hasMoveTarget = false;
      myVel.set(0, 0);
    }
    if (!stunned && !chargeAnim.active && hasMoveTarget) {
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

    if (rCastUntil > 0 && myVel.lengthSq() > 0.0004) {
      rCastUntil = 0;
      rReadyAt = performance.now();
      const maxMana = (me && me.maxMana) ? me.maxMana : startMana;
      myMana = Math.min(maxMana, myMana + R_COST);
    }

    let moved = 0;
    if (!chargeAnim.active) {
      const nx = myPos.x + myVel.x * dt;
      const nz = myPos.z + myVel.y * dt;
      const res = resolveMove(myPos.x, myPos.z, nx, nz, PLAYER_RADIUS);
      moved = Math.hypot(res.x - myPos.x, res.z - myPos.z);
      myPos.x = res.x;
      myPos.z = res.z;
    }
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
    rMode = false;
    rCastUntil = 0;
    chargeAnim.active = false;
    hasMoveTarget = false;
    myVel.set(0, 0);
    sprintTrail.visible = false;
    slotQ.classList.remove('targeting');
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
  refreshProjectileCollisionTargets();
  updateProjectiles(dt);
  updateGroundBursts(performance.now());
  updateBeamWarnings(performance.now());
  updatePools(performance.now());
  updatePickups();
  updateNpcTalkVisibility();
  updateActiveBuffIcons(Date.now());

  // skillshot / autoattack aim indicator
  if (alive && hasMouse) {
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

  teleportRange.visible = false;

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
  updateSlotRadiusPreview(alive);
  const wRemain = Math.max(0, wActiveUntil - now);
  for (const slotKey of Object.keys(slotEls)) {
    const mask = slotMaskEls[slotKey];
    const equipped = equippedBySlot[slotKey];
    const ratio = spellCooldownRatio(equipped, now, statsNow);
    if (mask) mask.style.transform = `scaleY(${ratio})`;
  }
  if (wRemain > 0) {
    buffWIndicator.hidden = false;
    buffWIndicator.textContent = `Sprint ${Math.ceil(wRemain / 1000)}s`;
  } else {
    buffWIndicator.hidden = true;
  }
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
  for (const slotKey of Object.keys(slotEls)) {
    const slot = slotEls[slotKey];
    const equipped = equippedBySlot[slotKey];
    const can = canCastSpell(equipped, alive, now);
    slot.classList.toggle('disabled', !equipped || !can);
  }
  if (!canCastSpell('q', alive, now) && qMode) {
    qMode = false;
    slotQ.classList.remove('targeting');
  }
  if (!canCastSpell('r', alive, now) && rMode) {
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

  // minimap removed for performance

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
