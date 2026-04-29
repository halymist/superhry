package main

import (
	"encoding/json"
	"log"
	"math"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Arena is a single shared FFA lobby.
//
// Authority model: client-authoritative for movement and projectile motion.
// The server only relays messages and tracks HP so kills are consistent
// across all clients. There is no persistence.

const (
	tickRate     = 20 // Hz, server snapshot broadcast rate
	maxPlayers   = 32
	startHP      = 100
	startMana    = 100
	hitDamage    = 40
	respawnMS    = 6000
	mapHalfX     = 36.0
	mapHalfZ     = 22.0
	maxNameLen   = 16
	sendQueueLen = 64

	hpRegenPerSec   = 2.0
	manaRegenPerSec = 8.0

	pickupSpawnMS     = 9000
	maxPickups        = 3
	pickupAmount      = 20
	goldAmount        = 1
	pickupRadius      = 1.2 // pickup-collection distance
	pickupLifeMS      = 30000
	npcSayMS          = 7000
	npcRespawnMS      = 5000
	dogHP             = 90
	dogAggroRange     = 11.0
	dogDeaggroRng     = 16.0
	dogTouchRange     = 1.15
	dogTouchDmg       = 14
	dogHitCDMS        = 900
	dogChaseSpeed     = 4.7
	dogWanderSpeed    = 2.45
	reditelHP         = 900
	reditelRegenPS    = 18.0
	namestekTalkCDMS  = 10000
	sofieFollowRange  = 10.0
	sofieFollowDrop   = 16.0
	sofieFollowSpeed  = 1.85
	sofieFollowMS     = 5000
	sofieFollowCDMS   = 7000
	namestekLootRange = 6.0
	namestekLootSpeed = 1.55

	reditelMissileSpeed = 12.0
	reditelMissileRange = 10.0
	reditelMissileRad   = 0.22
	reditelMissileDmg   = 9
	reditelShotCDMS     = 140
	reditelBurstMS      = 3000
	reditelPauseMS      = 1700
	reditelGoldDropMS   = 12000
	reditelBeamCDMS     = 12000
	reditelBeamSpeed    = 78.0
	reditelBeamRange    = 44.0
	reditelBeamRad      = 0.78
	reditelBeamDmg      = 80
	reditelBeamWindupMS = 700

	chargeCost       = 40
	chargeDashDist   = 8.8
	chargeHitRadius  = 1.2
	chargeDamageBase = 16
	chargeDamageStep = 12
	chargeStunMS     = 1000

	V_COST = 55
	X_COST = 45

	vBaseRadius = 5.7
	vRadStep    = 0.22

	xStunBaseMS = 2000
	xStunStepMS = 200

	playerRadius = 0.6

	hpUpgradeDelta   = 20
	manaUpgradeDelta = 20
	hpManaUpgradeMax = 10
	spellUpgradeMax  = 5
)

func manaCost(kind string) int {
	switch kind {
	case "q":
		return 35
	case "w":
		return 30
	case "r":
		return 75
	case "e":
		return 50
	case "c":
		return chargeCost
	case "v":
		return V_COST
	case "x":
		return X_COST
	}
	return 0
}

func upgradeCost(kind string, _ int) int {
	return 3
}

type vec2 struct {
	X float64 `json:"x"`
	Z float64 `json:"z"`
}

type playerState struct {
	ID        uint64  `json:"id"`
	Name      string  `json:"name"`
	X         float64 `json:"x"`
	Z         float64 `json:"z"`
	Facing    float64 `json:"facing"`
	HP        int     `json:"hp"`
	Mana      int     `json:"mana"`
	MaxHP     int     `json:"maxHp"`
	MaxMana   int     `json:"maxMana"`
	Gold      int     `json:"gold"`
	UpHP      int     `json:"upHp"`
	UpMana    int     `json:"upMana"`
	UpQ       int     `json:"upQ"`
	UpW       int     `json:"upW"`
	UpE       int     `json:"upE"`
	UpR       int     `json:"upR"`
	UpC       int     `json:"upC"`
	UpV       int     `json:"upV"`
	UpX       int     `json:"upX"`
	Alive     bool    `json:"alive"`
	StunUntil int64   `json:"stunUntil,omitempty"`
	RespawnT  int64   `json:"respawnAt,omitempty"` // unix ms; 0 if alive
}

type pickup struct {
	ID        uint64  `json:"id"`
	Kind      string  `json:"kind"` // "hp" or "mana" or "gold"
	Value     int     `json:"value,omitempty"`
	X         float64 `json:"x"`
	Z         float64 `json:"z"`
	SpawnAtMS int64   `json:"spawnAtMs"`
	ExpireMS  int64   `json:"expireAtMs"`
}

var (
	namestekLines = []string{
		"Nevíte, kde je Martin?",
		"Je tady Martin",
		"Martin?",
		"Pošlete za mnou Martina",
		"Hledám Martina",
		"Neviděl někdo Martina?",
		"Martineee?",
		"Byl tady Martin?",
	}
	dogLines = []string{
		"Woof woof",
		"Grrr",
		"Haf haf",
		"Vrrr",
		"Au au",
	}
	sofieLines = []string{
		"Привет!",
		"Как дела?",
		"Спасибо!",
		"Давай, погнали!",
		"Ну ладно...",
	}
)

type npcProjectile struct {
	ID    uint64
	Owner uint64
	X     float64
	Z     float64
	DX    float64
	DZ    float64
	Speed float64
	Range float64
	Dist  float64
	Rad   float64
	Dmg   int
	Kind  string
}

type npcState struct {
	ID        uint64  `json:"id"`
	Kind      string  `json:"kind"`
	Name      string  `json:"name"`
	X         float64 `json:"x"`
	Z         float64 `json:"z"`
	Facing    float64 `json:"facing"`
	Scale     float64 `json:"scale"`
	HP        int     `json:"hp,omitempty"`
	MaxHP     int     `json:"maxHp,omitempty"`
	Alive     bool    `json:"alive"`
	StunUntil int64   `json:"stunUntil,omitempty"`
	RespawnT  int64   `json:"respawnAt,omitempty"`
	Say       string  `json:"say,omitempty"`
	SayUntil  int64   `json:"sayUntil,omitempty"`
}

type npcRuntime struct {
	state       npcState
	vx          float64
	vz          float64
	hpAcc       float64
	nextDirMS   int64
	nextSayMS   int64
	nextHitMS   int64
	nextDropMS  int64
	nextBeamMS  int64
	beamFireMS  int64
	beamDX      float64
	beamDZ      float64
	burstEndMS  int64
	pauseToMS   int64
	followToMS  int64
	aggroID     uint64
	stunUntilMS int64
}

// --- inbound client messages ---

type cMsg struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

type cJoin struct {
	Name string `json:"name"`
}

type cState struct {
	X      float64 `json:"x"`
	Z      float64 `json:"z"`
	Facing float64 `json:"facing"`
}

type cFire struct {
	PID  uint64  `json:"pid"` // client-chosen projectile id (unique per shooter)
	OX   float64 `json:"ox"`
	OZ   float64 `json:"oz"`
	DX   float64 `json:"dx"`
	DZ   float64 `json:"dz"`
	Kind string  `json:"kind"`
}

type cHit struct {
	PID    uint64 `json:"pid"`    // projectile id assigned by shooter
	Target uint64 `json:"target"` // target player id
	Dmg    int    `json:"dmg"`    // optional damage; 0 = use default
}

type cCast struct {
	Kind string `json:"kind"` // "e" etc. (non-projectile mana spend)
}

type cPickup struct {
	ID uint64 `json:"id"`
}

type cUpgrade struct {
	Kind string `json:"kind"` // "hp","mana","q","w","e","r","c","v","x"
}

// --- outbound server messages ---

type sMsg struct {
	Type string      `json:"type"`
	Data interface{} `json:"data,omitempty"`
}

type sWelcome struct {
	YouID     uint64  `json:"youId"`
	TickRate  int     `json:"tickRate"`
	HalfX     float64 `json:"halfX"`
	HalfZ     float64 `json:"halfZ"`
	StartHP   int     `json:"startHp"`
	StartMana int     `json:"startMana"`
	HitDmg    int     `json:"hitDmg"`
	NowMS     int64   `json:"nowMs"`
}

type sSnapshot struct {
	T       int64         `json:"t"` // unix ms
	Players []playerState `json:"players"`
	Pickups []pickup      `json:"pickups"`
	Npcs    []npcState    `json:"npcs"`
}

type sFire struct {
	Owner uint64  `json:"owner"`
	PID   uint64  `json:"pid"`
	OX    float64 `json:"ox"`
	OZ    float64 `json:"oz"`
	DX    float64 `json:"dx"`
	DZ    float64 `json:"dz"`
	Kind  string  `json:"kind"`
	T     int64   `json:"t"`
}

type sHit struct {
	Shooter uint64 `json:"shooter"`
	Target  uint64 `json:"target"`
	PID     uint64 `json:"pid"`
	HP      int    `json:"hp"`
	Killed  bool   `json:"killed"`
	T       int64  `json:"t"`
}

type sLeave struct {
	ID uint64 `json:"id"`
}

type sChat struct { // simple killfeed-style relay (unused for now)
	From uint64 `json:"from"`
	Text string `json:"text"`
}

// --- hub & client ---

type client struct {
	id   uint64
	hub  *ArenaHub
	conn *websocket.Conn
	send chan []byte

	mu      sync.Mutex
	state   playerState
	hpAcc   float64
	manaAcc float64
}

type ArenaHub struct {
	register   chan *client
	unregister chan *client
	broadcast  chan []byte

	// inbound game events (hub-owned mutations)
	stateUpd chan stateUpdate
	hitEvt   chan hitEvent
	castEvt  chan castEvent
	fireEvt  chan fireEvent
	pickEvt  chan pickEvent
	upgEvt   chan upgradeEvent

	clients    map[uint64]*client
	nextID     atomic.Uint64
	pickups    map[uint64]*pickup
	nextPickID atomic.Uint64
	lastPickup time.Time
	lastTick   time.Time
	respawnAt  map[uint64]int64
	auras      map[uint64]*playerAura
	projKinds  map[uint64]map[uint64]string
	npcs       map[uint64]*npcRuntime
	npcProjs   map[uint64]*npcProjectile
	nextNpcPID atomic.Uint64
}

type playerAura struct {
	Owner    uint64
	EndMS    int64
	NextTick int64
	Radius   float64
	Damage   int
}

type stateUpdate struct {
	id     uint64
	x, z   float64
	facing float64
}

type hitEvent struct {
	shooter uint64
	target  uint64
	pid     uint64
	dmg     int
}

type castEvent struct {
	id   uint64
	kind string
}

type fireEvent struct {
	shooter uint64
	pid     uint64
	ox, oz  float64
	dx, dz  float64
	kind    string
}

type pickEvent struct {
	player uint64
	pickup uint64
}

type upgradeEvent struct {
	player uint64
	kind   string
}

func NewArenaHub() *ArenaHub {
	return &ArenaHub{
		register:   make(chan *client, 16),
		unregister: make(chan *client, 16),
		broadcast:  make(chan []byte, 256),
		stateUpd:   make(chan stateUpdate, 1024),
		hitEvt:     make(chan hitEvent, 256),
		castEvt:    make(chan castEvent, 256),
		fireEvt:    make(chan fireEvent, 256),
		pickEvt:    make(chan pickEvent, 256),
		upgEvt:     make(chan upgradeEvent, 256),
		clients:    make(map[uint64]*client),
		pickups:    make(map[uint64]*pickup),
		lastTick:   time.Now(),
		respawnAt:  make(map[uint64]int64),
		auras:      make(map[uint64]*playerAura),
		projKinds:  make(map[uint64]map[uint64]string),
		npcs:       make(map[uint64]*npcRuntime),
		npcProjs:   make(map[uint64]*npcProjectile),
	}
}

func (h *ArenaHub) initNPCs() {
	now := time.Now().UnixMilli()
	h.npcs[1001] = &npcRuntime{
		state:     npcState{ID: 1001, Kind: "namestek", Name: "Náměstek", X: -6, Z: 4, Facing: 0, Scale: 1.0, Alive: true},
		nextDirMS: now + 1200,
		nextSayMS: now + 3000,
	}
	h.npcs[1002] = &npcRuntime{
		state:      npcState{ID: 1002, Kind: "reditel", Name: "Ředitel", X: 10, Z: -8, Facing: 0, Scale: 1.0, HP: reditelHP, MaxHP: reditelHP, Alive: true},
		nextDirMS:  now + 900,
		nextSayMS:  now + 1000000,
		nextDropMS: now + reditelGoldDropMS,
		nextBeamMS: now + 7000,
	}
	h.npcs[1003] = &npcRuntime{
		state:     npcState{ID: 1003, Kind: "pes", Name: "Pes", X: 2, Z: 2, Facing: 0, Scale: 1.0, HP: dogHP, MaxHP: dogHP, Alive: true},
		nextDirMS: now + 1000,
		nextSayMS: now + 2600,
	}
	h.npcs[1004] = &npcRuntime{
		state:     npcState{ID: 1004, Kind: "sofie", Name: "Sofie", X: -12, Z: -4, Facing: 0, Scale: 1.0, Alive: true},
		nextDirMS: now + 1500,
		nextSayMS: now + 3500,
		pauseToMS: now + 1200,
	}
}

func (h *ArenaHub) Run() {
	h.initNPCs()
	ticker := time.NewTicker(time.Second / tickRate)
	defer ticker.Stop()

	for {
		select {
		case c := <-h.register:
			h.clients[c.id] = c

		case c := <-h.unregister:
			if _, ok := h.clients[c.id]; ok {
				delete(h.clients, c.id)
				delete(h.auras, c.id)
				delete(h.projKinds, c.id)
				close(c.send)
				h.broadcastJSON(sMsg{Type: "leave", Data: sLeave{ID: c.id}})
			}

		case u := <-h.stateUpd:
			if c, ok := h.clients[u.id]; ok {
				c.mu.Lock()
				if c.state.Alive {
					nowMS := time.Now().UnixMilli()
					if nowMS >= c.state.StunUntil {
						c.state.X = clamp(u.x, -mapHalfX, mapHalfX)
						c.state.Z = clamp(u.z, -mapHalfZ, mapHalfZ)
					}
					c.state.Facing = u.facing
				}
				c.mu.Unlock()
			}

		case ev := <-h.hitEvt:
			h.applyHit(ev)

		case ev := <-h.castEvt:
			h.applyCast(ev)

		case ev := <-h.fireEvt:
			h.applyFire(ev)

		case ev := <-h.pickEvt:
			h.applyPickup(ev)

		case ev := <-h.upgEvt:
			h.applyUpgrade(ev)

		case <-ticker.C:
			now := time.Now()
			dt := now.Sub(h.lastTick).Seconds()
			if dt < 0 || dt > 1 {
				dt = 1.0 / float64(tickRate)
			}
			h.lastTick = now
			h.processRespawns(now.UnixMilli())
			h.regen(dt)
			h.expirePickups(now)
			h.maybeSpawnPickup(now)
			h.updateNPCs(now, dt)
			h.updateAuras(now.UnixMilli())
			h.updateNPCProjectiles(dt)
			h.sendSnapshot()
		}
	}
}

func (h *ArenaHub) updateAuras(nowMS int64) {
	for owner, a := range h.auras {
		if nowMS >= a.EndMS {
			delete(h.auras, owner)
			continue
		}
		c, ok := h.clients[owner]
		if !ok {
			delete(h.auras, owner)
			continue
		}
		c.mu.Lock()
		alive := c.state.Alive
		ox := c.state.X
		oz := c.state.Z
		c.mu.Unlock()
		if !alive {
			delete(h.auras, owner)
			continue
		}
		if nowMS < a.NextTick {
			continue
		}
		a.NextTick = nowMS + 500

		hitR2Player := (a.Radius + playerRadius) * (a.Radius + playerRadius)
		for id, t := range h.clients {
			if id == owner {
				continue
			}
			t.mu.Lock()
			tAlive := t.state.Alive
			tx := t.state.X
			tz := t.state.Z
			t.mu.Unlock()
			if !tAlive {
				continue
			}
			dx := tx - ox
			dz := tz - oz
			if dx*dx+dz*dz <= hitR2Player {
				h.applyHit(hitEvent{shooter: owner, target: id, pid: 0, dmg: a.Damage})
			}
		}

		for id, n := range h.npcs {
			if !n.state.Alive {
				continue
			}
			if n.state.Kind != "pes" && n.state.Kind != "reditel" {
				continue
			}
			nrad := 0.6
			if n.state.Kind == "reditel" {
				nrad = 1.05
			}
			r := a.Radius + nrad
			dx := n.state.X - ox
			dz := n.state.Z - oz
			if dx*dx+dz*dz <= r*r {
				h.applyHit(hitEvent{shooter: owner, target: id, pid: 0, dmg: a.Damage})
			}
		}
	}
}

func (h *ArenaHub) processRespawns(nowMS int64) {
	for id, atMS := range h.respawnAt {
		if nowMS < atMS {
			continue
		}
		h.respawnPlayer(id)
		delete(h.respawnAt, id)
	}
}

func (h *ArenaHub) respawnPlayer(id uint64) {
	c, ok := h.clients[id]
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.MaxHP <= 0 {
		c.state.MaxHP = startHP
	}
	if c.state.MaxMana <= 0 {
		c.state.MaxMana = startMana
	}
	c.state.HP = c.state.MaxHP
	c.state.Mana = c.state.MaxMana
	c.state.Alive = true
	c.state.StunUntil = 0
	c.state.RespawnT = 0
	c.state.X = (rand.Float64()*2 - 1) * (mapHalfX - 2)
	c.state.Z = (rand.Float64()*2 - 1) * (mapHalfZ - 2)
	c.hpAcc = 0
	c.manaAcc = 0
}

func (h *ArenaHub) updateNPCs(now time.Time, dt float64) {
	nowMS := now.UnixMilli()

	for _, n := range h.npcs {
		if !n.state.Alive {
			if n.state.RespawnT > 0 && nowMS >= n.state.RespawnT {
				n.state.Alive = true
				n.state.RespawnT = 0
				n.state.X = (rand.Float64()*2 - 1) * (mapHalfX - 2)
				n.state.Z = (rand.Float64()*2 - 1) * (mapHalfZ - 2)
				n.vx = 0
				n.vz = 0
				n.nextDirMS = nowMS + 600
				n.nextSayMS = nowMS + 2400
				n.nextHitMS = 0
				n.stunUntilMS = 0
				n.hpAcc = 0
				if n.state.Kind == "pes" {
					n.state.HP = dogHP
					n.state.MaxHP = dogHP
				}
				if n.state.Kind == "reditel" {
					n.state.HP = reditelHP
					n.state.MaxHP = reditelHP
					n.nextBeamMS = nowMS + 7000
					n.beamFireMS = 0
				}
				n.state.StunUntil = 0
			}
			continue
		}

		if nowMS < n.stunUntilMS {
			n.state.StunUntil = n.stunUntilMS
			n.vx = 0
			n.vz = 0
			if n.state.SayUntil > 0 && nowMS >= n.state.SayUntil {
				n.state.Say = ""
				n.state.SayUntil = 0
			}
			continue
		}
		n.state.StunUntil = 0

		if n.state.Kind == "reditel" {
			if n.state.MaxHP <= 0 {
				n.state.MaxHP = reditelHP
			}
			if n.state.HP < n.state.MaxHP {
				n.hpAcc += reditelRegenPS * dt
				if n.hpAcc >= 1 {
					add := int(n.hpAcc)
					n.hpAcc -= float64(add)
					n.state.HP += add
					if n.state.HP > n.state.MaxHP {
						n.state.HP = n.state.MaxHP
					}
				}
			} else {
				n.hpAcc = 0
			}
		}

		speed := 1.3
		if n.state.Kind == "reditel" {
			speed = 0.9
		}
		if n.state.Kind == "pes" {
			speed = dogWanderSpeed
		}

		if n.state.Kind == "namestek" {
			var best *pickup
			bestD2 := namestekLootRange * namestekLootRange
			for _, p := range h.pickups {
				if p.Kind != "hp" && p.Kind != "mana" && p.Kind != "gold" {
					continue
				}
				dx := p.X - n.state.X
				dz := p.Z - n.state.Z
				d2 := dx*dx + dz*dz
				if d2 <= bestD2 {
					bestD2 = d2
					best = p
				}
			}
			if best != nil {
				dx := best.X - n.state.X
				dz := best.Z - n.state.Z
				d := math.Hypot(dx, dz)
				if d <= pickupRadius+0.35 {
					delete(h.pickups, best.ID)
					n.vx = 0
					n.vz = 0
				} else if d > 0.001 {
					n.vx = dx / d * namestekLootSpeed
					n.vz = dz / d * namestekLootSpeed
					n.state.Facing = math.Atan2(n.vx, n.vz)
					n.nextDirMS = nowMS + 350
				}
			}
		}

		if n.state.Kind == "reditel" {
			if nowMS >= n.nextDropMS {
				h.spawnPickup("gold", n.state.X, n.state.Z, true, now)
				n.nextDropMS = nowMS + reditelGoldDropMS + int64(rand.Intn(5000))
			}
			if n.beamFireMS > 0 {
				n.vx = 0
				n.vz = 0
				if nowMS >= n.beamFireMS {
					d := math.Hypot(n.beamDX, n.beamDZ)
					if d > 0.001 {
						h.spawnReditelBeam(n.state.ID, n.state.X+n.beamDX/d*1.0, n.state.Z+n.beamDZ/d*1.0, n.beamDX/d, n.beamDZ/d)
					}
					n.beamFireMS = 0
				}
			}
			if n.beamFireMS == 0 && nowMS >= n.nextBeamMS {
				var target *client
				minD2 := math.MaxFloat64
				for _, c := range h.clients {
					c.mu.Lock()
					alive := c.state.Alive
					px := c.state.X
					pz := c.state.Z
					c.mu.Unlock()
					if !alive {
						continue
					}
					dx := px - n.state.X
					dz := pz - n.state.Z
					d2 := dx*dx + dz*dz
					if d2 < minD2 {
						minD2 = d2
						target = c
					}
				}
				if target != nil {
					target.mu.Lock()
					tx := target.state.X
					tz := target.state.Z
					target.mu.Unlock()
					dx := tx - n.state.X
					dz := tz - n.state.Z
					d := math.Hypot(dx, dz)
					if d > 0.001 {
						n.state.Facing = math.Atan2(dx, dz)
						n.beamDX = dx / d
						n.beamDZ = dz / d
						n.beamFireMS = nowMS + reditelBeamWindupMS
						n.vx = 0
						n.vz = 0
						h.spawnReditelBeamWarning(n.state.ID, n.state.X+n.beamDX*1.0, n.state.Z+n.beamDZ*1.0, n.beamDX, n.beamDZ)
					}
				}
				n.nextBeamMS = nowMS + reditelBeamCDMS + int64(rand.Intn(4000))
			}
			if n.beamFireMS == 0 && nowMS >= n.pauseToMS && n.burstEndMS == 0 {
				n.burstEndMS = nowMS + reditelBurstMS
				n.nextHitMS = nowMS
			}
			if n.beamFireMS == 0 && n.burstEndMS > 0 && nowMS >= n.burstEndMS {
				n.burstEndMS = 0
				n.pauseToMS = nowMS + reditelPauseMS
				n.nextHitMS = n.pauseToMS
			}
			if n.beamFireMS == 0 && n.burstEndMS > 0 && nowMS >= n.nextHitMS {
				var target *client
				minD2 := reditelMissileRange * reditelMissileRange
				for _, c := range h.clients {
					c.mu.Lock()
					alive := c.state.Alive
					px := c.state.X
					pz := c.state.Z
					c.mu.Unlock()
					if !alive {
						continue
					}
					dx := px - n.state.X
					dz := pz - n.state.Z
					d2 := dx*dx + dz*dz
					if d2 <= minD2 {
						minD2 = d2
						target = c
					}
				}
				if target != nil {
					target.mu.Lock()
					tx := target.state.X
					tz := target.state.Z
					target.mu.Unlock()
					dx := tx - n.state.X
					dz := tz - n.state.Z
					d := math.Hypot(dx, dz)
					if d > 0.001 {
						n.state.Facing = math.Atan2(dx, dz)
						h.spawnNPCProjectile(n.state.ID, n.state.X+dx/d*0.9, n.state.Z+dz/d*0.9, dx/d, dz/d)
					}
				}
				n.nextHitMS = nowMS + reditelShotCDMS
			}
		}

		if n.state.Kind == "pes" {
			closestID := uint64(0)
			closestD2 := math.MaxFloat64
			for _, c := range h.clients {
				c.mu.Lock()
				alive := c.state.Alive
				px := c.state.X
				pz := c.state.Z
				pid := c.id
				c.mu.Unlock()
				if !alive {
					continue
				}
				dx := px - n.state.X
				dz := pz - n.state.Z
				d2 := dx*dx + dz*dz
				if d2 < closestD2 {
					closestD2 = d2
					closestID = pid
				}
			}

			hasTarget := false
			targetID := n.aggroID
			if targetID != 0 {
				if tc, ok := h.clients[targetID]; ok {
					tc.mu.Lock()
					tAlive := tc.state.Alive
					tx := tc.state.X
					tz := tc.state.Z
					tc.mu.Unlock()
					if tAlive {
						dx := tx - n.state.X
						dz := tz - n.state.Z
						if dx*dx+dz*dz <= dogDeaggroRng*dogDeaggroRng {
							hasTarget = true
						}
					}
				}
			}

			if !hasTarget {
				n.aggroID = 0
				if closestID != 0 && closestD2 <= dogAggroRange*dogAggroRange {
					n.aggroID = closestID
					hasTarget = true
					if nowMS >= n.nextSayMS {
						n.state.Say = pickDifferentLine(dogLines, n.state.Say)
						n.state.SayUntil = nowMS + npcSayMS
						n.nextSayMS = nowMS + 12000 + int64(rand.Intn(6000))
					}
				}
			}

			if hasTarget {
				tc := h.clients[n.aggroID]
				if tc != nil {
					tc.mu.Lock()
					tx := tc.state.X
					tz := tc.state.Z
					tid := tc.id
					tAlive := tc.state.Alive
					tc.mu.Unlock()
					if tAlive {
						dx := tx - n.state.X
						dz := tz - n.state.Z
						d := math.Hypot(dx, dz)
						if d > 0.001 {
							n.vx = dx / d * dogChaseSpeed
							n.vz = dz / d * dogChaseSpeed
							n.state.Facing = math.Atan2(n.vx, n.vz)
						}
						if d <= dogTouchRange && nowMS >= n.nextHitMS {
							n.nextHitMS = nowMS + dogHitCDMS
							h.applyHit(hitEvent{shooter: n.state.ID, target: tid, pid: 0, dmg: dogTouchDmg})
						}
					}
				}
			} else if nowMS >= n.nextDirMS {
				ang := rand.Float64() * math.Pi * 2
				n.vx = math.Sin(ang) * speed
				n.vz = math.Cos(ang) * speed
				n.state.Facing = math.Atan2(n.vx, n.vz)
				n.nextDirMS = nowMS + 1400 + int64(rand.Intn(2600))
			}
		} else if n.state.Kind == "sofie" {
			following := false
			if n.aggroID != 0 && nowMS < n.followToMS {
				if tc, ok := h.clients[n.aggroID]; ok {
					tc.mu.Lock()
					tAlive := tc.state.Alive
					tx := tc.state.X
					tz := tc.state.Z
					tc.mu.Unlock()
					if tAlive {
						dx := tx - n.state.X
						dz := tz - n.state.Z
						d2 := dx*dx + dz*dz
						if d2 <= sofieFollowDrop*sofieFollowDrop {
							following = true
							if nowMS >= n.nextSayMS && (n.state.SayUntil <= 0 || nowMS >= n.state.SayUntil) {
								n.state.Say = pickDifferentLine(sofieLines, n.state.Say)
								n.state.SayUntil = nowMS + npcSayMS
								n.nextSayMS = nowMS + 2200 + int64(rand.Intn(2200))
							}
							d := math.Sqrt(d2)
							if d > 1.35 {
								n.vx = dx / d * sofieFollowSpeed
								n.vz = dz / d * sofieFollowSpeed
								n.state.Facing = math.Atan2(n.vx, n.vz)
							} else {
								n.vx = 0
								n.vz = 0
							}
						}
					}
				}
			}

			if !following {
				n.aggroID = 0
				n.followToMS = 0
				n.state.Say = ""
				n.state.SayUntil = 0
				if nowMS >= n.pauseToMS {
					bestID := uint64(0)
					bestD2 := sofieFollowRange * sofieFollowRange
					for _, c := range h.clients {
						c.mu.Lock()
						alive := c.state.Alive
						px := c.state.X
						pz := c.state.Z
						pid := c.id
						c.mu.Unlock()
						if !alive {
							continue
						}
						dx := px - n.state.X
						dz := pz - n.state.Z
						d2 := dx*dx + dz*dz
						if d2 <= bestD2 {
							bestD2 = d2
							bestID = pid
						}
					}
					if bestID != 0 {
						n.aggroID = bestID
						n.followToMS = nowMS + sofieFollowMS
						n.pauseToMS = n.followToMS + sofieFollowCDMS
						if n.state.SayUntil <= 0 || nowMS >= n.state.SayUntil {
							n.state.Say = pickDifferentLine(sofieLines, n.state.Say)
							n.state.SayUntil = nowMS + npcSayMS
							n.nextSayMS = nowMS + 6000 + int64(rand.Intn(5000))
						} else {
							n.nextSayMS = n.state.SayUntil + 2200
						}
					}
				}

				if n.aggroID == 0 && nowMS >= n.nextDirMS {
					ang := rand.Float64() * math.Pi * 2
					n.vx = math.Sin(ang) * speed
					n.vz = math.Cos(ang) * speed
					n.state.Facing = math.Atan2(n.vx, n.vz)
					n.nextDirMS = nowMS + 1400 + int64(rand.Intn(2600))
				}
			}
		} else if n.state.Kind == "reditel" && n.beamFireMS > nowMS {
			n.vx = 0
			n.vz = 0
		} else if nowMS >= n.nextDirMS {
			ang := rand.Float64() * math.Pi * 2
			n.vx = math.Sin(ang) * speed
			n.vz = math.Cos(ang) * speed
			n.state.Facing = math.Atan2(n.vx, n.vz)
			n.nextDirMS = nowMS + 1400 + int64(rand.Intn(2600))
		}

		n.state.X += n.vx * dt
		n.state.Z += n.vz * dt
		if n.state.X < -mapHalfX+1 || n.state.X > mapHalfX-1 {
			n.vx = -n.vx
			n.state.X = clamp(n.state.X, -mapHalfX+1, mapHalfX-1)
		}
		if n.state.Z < -mapHalfZ+1 || n.state.Z > mapHalfZ-1 {
			n.vz = -n.vz
			n.state.Z = clamp(n.state.Z, -mapHalfZ+1, mapHalfZ-1)
		}
		n.state.Facing = math.Atan2(n.vx, n.vz)

		if n.state.SayUntil > 0 && nowMS >= n.state.SayUntil {
			n.state.Say = ""
			n.state.SayUntil = 0
		}

		if n.state.Kind == "namestek" && nowMS >= n.nextSayMS {
			if n.state.Say != "" && n.state.SayUntil > nowMS {
				n.nextSayMS = n.state.SayUntil + namestekTalkCDMS
				continue
			}
			near := false
			for _, c := range h.clients {
				c.mu.Lock()
				alive := c.state.Alive
				px := c.state.X
				pz := c.state.Z
				c.mu.Unlock()
				if !alive {
					continue
				}
				dx := px - n.state.X
				dz := pz - n.state.Z
				if dx*dx+dz*dz <= 14*14 {
					near = true
					break
				}
			}
			if near {
				n.state.Say = pickDifferentLine(namestekLines, n.state.Say)
				n.state.SayUntil = nowMS + npcSayMS
				n.nextSayMS = nowMS + namestekTalkCDMS + int64(rand.Intn(3000))
			} else {
				n.nextSayMS = nowMS + 4500
			}
		}

	}
}

func (h *ArenaHub) spawnNPCProjectile(owner uint64, x, z, dx, dz float64) {
	id := h.nextNpcPID.Add(1)
	h.npcProjs[id] = &npcProjectile{
		ID:    id,
		Owner: owner,
		X:     x,
		Z:     z,
		DX:    dx,
		DZ:    dz,
		Speed: reditelMissileSpeed,
		Range: reditelMissileRange,
		Rad:   reditelMissileRad,
		Dmg:   reditelMissileDmg,
		Kind:  "reditel",
	}
	h.broadcastJSON(sMsg{Type: "fire", Data: sFire{
		Owner: owner,
		PID:   id,
		OX:    x,
		OZ:    z,
		DX:    dx,
		DZ:    dz,
		Kind:  "reditel",
		T:     time.Now().UnixMilli(),
	}})
}

func (h *ArenaHub) spawnReditelBeam(owner uint64, x, z, dx, dz float64) {
	id := h.nextNpcPID.Add(1)
	h.npcProjs[id] = &npcProjectile{
		ID:    id,
		Owner: owner,
		X:     x,
		Z:     z,
		DX:    dx,
		DZ:    dz,
		Speed: reditelBeamSpeed,
		Range: reditelBeamRange,
		Rad:   reditelBeamRad,
		Dmg:   reditelBeamDmg,
		Kind:  "reditel_beam",
	}
	h.broadcastJSON(sMsg{Type: "fire", Data: sFire{
		Owner: owner,
		PID:   id,
		OX:    x,
		OZ:    z,
		DX:    dx,
		DZ:    dz,
		Kind:  "reditel_beam",
		T:     time.Now().UnixMilli(),
	}})
}

func (h *ArenaHub) spawnReditelBeamWarning(owner uint64, x, z, dx, dz float64) {
	h.broadcastJSON(sMsg{Type: "fire", Data: sFire{
		Owner: owner,
		PID:   0,
		OX:    x,
		OZ:    z,
		DX:    dx,
		DZ:    dz,
		Kind:  "reditel_beam_warn",
		T:     time.Now().UnixMilli(),
	}})
}

func (h *ArenaHub) updateNPCProjectiles(dt float64) {
	type projTarget struct {
		id uint64
		x  float64
		z  float64
	}
	targets := make([]projTarget, 0, len(h.clients))
	for _, c := range h.clients {
		c.mu.Lock()
		alive := c.state.Alive
		px := c.state.X
		pz := c.state.Z
		pid := c.id
		c.mu.Unlock()
		if alive {
			targets = append(targets, projTarget{id: pid, x: px, z: pz})
		}
	}

	for id, pr := range h.npcProjs {
		stepX := pr.DX * pr.Speed * dt
		stepZ := pr.DZ * pr.Speed * dt
		pr.X += stepX
		pr.Z += stepZ
		pr.Dist += math.Hypot(stepX, stepZ)
		if pr.Dist >= pr.Range || pr.X < -mapHalfX-2 || pr.X > mapHalfX+2 || pr.Z < -mapHalfZ-2 || pr.Z > mapHalfZ+2 {
			delete(h.npcProjs, id)
			continue
		}

		hitR := pr.Rad + playerRadius
		hitR2 := hitR * hitR
		hit := false
		for _, t := range targets {
			dx := t.x - pr.X
			if dx > hitR || dx < -hitR {
				continue
			}
			dz := t.z - pr.Z
			if dz > hitR || dz < -hitR {
				continue
			}
			if dx*dx+dz*dz <= hitR2 {
				h.applyHit(hitEvent{shooter: pr.Owner, target: t.id, pid: pr.ID, dmg: pr.Dmg})
				hit = true
				break
			}
		}
		if hit {
			delete(h.npcProjs, id)
		}
	}
}

func (h *ArenaHub) expirePickups(now time.Time) {
	nowMS := now.UnixMilli()
	for id, p := range h.pickups {
		if p.ExpireMS > 0 && nowMS >= p.ExpireMS {
			delete(h.pickups, id)
		}
	}
}

func (h *ArenaHub) regen(dt float64) {
	for _, c := range h.clients {
		c.mu.Lock()
		if c.state.Alive {
			maxHP := c.state.MaxHP
			if maxHP <= 0 {
				maxHP = startHP
			}
			maxMana := c.state.MaxMana
			if maxMana <= 0 {
				maxMana = startMana
			}
			if c.state.HP < maxHP {
				c.hpAcc += hpRegenPerSec * dt
				if c.hpAcc >= 1 {
					add := int(c.hpAcc)
					c.hpAcc -= float64(add)
					c.state.HP += add
					if c.state.HP > maxHP {
						c.state.HP = maxHP
					}
				}
			} else {
				c.hpAcc = 0
			}
			if c.state.Mana < maxMana {
				c.manaAcc += manaRegenPerSec * dt
				if c.manaAcc >= 1 {
					add := int(c.manaAcc)
					c.manaAcc -= float64(add)
					c.state.Mana += add
					if c.state.Mana > maxMana {
						c.state.Mana = maxMana
					}
				}
			} else {
				c.manaAcc = 0
			}
		}
		c.mu.Unlock()
	}
}

func (h *ArenaHub) maybeSpawnPickup(now time.Time) {
	if len(h.pickups) >= maxPickups {
		return
	}
	if now.Sub(h.lastPickup) < pickupSpawnMS*time.Millisecond {
		return
	}
	h.lastPickup = now
	kindRoll := rand.Intn(10)
	kind := "gold"
	if kindRoll == 0 {
		kind = "hp"
	} else if kindRoll <= 4 {
		kind = "mana"
	}
	h.spawnPickup(kind, 0, 0, false, now)
}

func (h *ArenaHub) spawnPickup(kind string, x, z float64, exact bool, now time.Time) {
	h.spawnPickupValue(kind, x, z, exact, now, 0)
}

func (h *ArenaHub) spawnPickupValue(kind string, x, z float64, exact bool, now time.Time, value int) {
	id := h.nextPickID.Add(1)
	nowMS := now.UnixMilli()
	px, pz := x, z
	if !exact {
		px = (rand.Float64()*2 - 1) * (mapHalfX - 2)
		pz = (rand.Float64()*2 - 1) * (mapHalfZ - 2)
	}
	if value <= 0 {
		value = 1
	}
	p := &pickup{
		ID:        id,
		Kind:      kind,
		Value:     value,
		X:         clamp(px, -mapHalfX+1, mapHalfX-1),
		Z:         clamp(pz, -mapHalfZ+1, mapHalfZ-1),
		SpawnAtMS: nowMS,
		ExpireMS:  nowMS + pickupLifeMS,
	}
	h.pickups[id] = p
}

func (h *ArenaHub) applyCast(ev castEvent) {
	c, ok := h.clients[ev.id]
	if !ok {
		return
	}
	cost := manaCost(ev.kind)
	c.mu.Lock()
	if !c.state.Alive {
		c.mu.Unlock()
		return
	}
	if ev.kind == "c" && c.state.UpC <= 0 {
		c.mu.Unlock()
		return
	}
	if ev.kind == "v" && c.state.UpV <= 0 {
		c.mu.Unlock()
		return
	}
	if ev.kind == "x" && c.state.UpX <= 0 {
		c.mu.Unlock()
		return
	}
	if c.state.Mana < cost {
		c.mu.Unlock()
		return
	}
	c.state.Mana -= cost

	if ev.kind != "c" && ev.kind != "v" && ev.kind != "x" {
		c.mu.Unlock()
		return
	}

	upC := c.state.UpC
	upV := c.state.UpV
	facing := c.state.Facing
	sx := c.state.X
	sz := c.state.Z
	owner := c.id
	dx := math.Sin(facing)
	dz := math.Cos(facing)
	c.mu.Unlock()

	if ev.kind == "x" {
		return
	}

	if ev.kind == "v" {
		radius := vBaseRadius + float64(upV)*vRadStep
		dmg := 6 + upV*4
		nowMS := time.Now().UnixMilli()
		h.auras[owner] = &playerAura{
			Owner:    owner,
			EndMS:    nowMS + 5000,
			NextTick: nowMS,
			Radius:   radius,
			Damage:   dmg,
		}
		h.broadcastJSON(sMsg{Type: "fire", Data: sFire{Owner: owner, PID: 0, OX: sx, OZ: sz, DX: radius, DZ: 5.0, Kind: "pool_cast", T: nowMS}})
		return
	}

	ex := clamp(sx+dx*chargeDashDist, -mapHalfX, mapHalfX)
	ez := clamp(sz+dz*chargeDashDist, -mapHalfZ, mapHalfZ)

	dmg := chargeDamage(upC)
	hitR := chargeHitRadius

	for id, t := range h.clients {
		if id == ev.id {
			continue
		}
		t.mu.Lock()
		tAlive := t.state.Alive
		tx := t.state.X
		tz := t.state.Z
		t.mu.Unlock()
		if !tAlive {
			continue
		}
		if pointSegmentDist2(tx, tz, sx, sz, ex, ez) <= hitR*hitR {
			h.applyHit(hitEvent{shooter: ev.id, target: id, pid: 0, dmg: dmg})
			h.applyStunPlayer(id, chargeStunMS)
		}
	}

	for id, n := range h.npcs {
		if !n.state.Alive {
			continue
		}
		if n.state.Kind != "pes" && n.state.Kind != "reditel" {
			continue
		}
		nrad := 0.6
		if n.state.Kind == "reditel" {
			nrad = 1.05
		}
		r := chargeHitRadius + nrad
		if pointSegmentDist2(n.state.X, n.state.Z, sx, sz, ex, ez) <= r*r {
			h.applyHit(hitEvent{shooter: ev.id, target: id, pid: 0, dmg: dmg})
			h.applyStunNPC(id, chargeStunMS)
		}
	}
}

func (h *ArenaHub) applyFire(ev fireEvent) {
	c, ok := h.clients[ev.shooter]
	if !ok {
		return
	}
	cost := manaCost(ev.kind)
	if ev.kind == "q" {
		cost = 0
	}
	c.mu.Lock()
	if !c.state.Alive || c.state.Mana < cost {
		c.mu.Unlock()
		return
	}
	c.state.Mana -= cost
	if ev.kind != "q" {
		h.registerProjectileKind(ev.shooter, ev.pid, ev.kind)
	}
	c.mu.Unlock()

	h.broadcastJSON(sMsg{Type: "fire", Data: sFire{
		Owner: ev.shooter, PID: ev.pid,
		OX: ev.ox, OZ: ev.oz, DX: ev.dx, DZ: ev.dz,
		Kind: ev.kind,
		T:    time.Now().UnixMilli(),
	}})
}

func (h *ArenaHub) applyPickup(ev pickEvent) {
	p, ok := h.pickups[ev.pickup]
	if !ok {
		return
	}
	c, ok := h.clients[ev.player]
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.state.Alive {
		return
	}
	dx := c.state.X - p.X
	dz := c.state.Z - p.Z
	if dx*dx+dz*dz > pickupRadius*pickupRadius*4 { // small grace
		return
	}
	delete(h.pickups, p.ID)
	switch p.Kind {
	case "hp":
		c.state.HP += pickupAmount
		maxHP := c.state.MaxHP
		if maxHP <= 0 {
			maxHP = startHP
		}
		if c.state.HP > maxHP {
			c.state.HP = maxHP
		}
	case "mana":
		c.state.Mana += pickupAmount
		maxMana := c.state.MaxMana
		if maxMana <= 0 {
			maxMana = startMana
		}
		if c.state.Mana > maxMana {
			c.state.Mana = maxMana
		}
	case "gold":
		v := p.Value
		if v <= 0 {
			v = goldAmount
		}
		c.state.Gold += v
	}
}

func (h *ArenaHub) applyUpgrade(ev upgradeEvent) {
	c, ok := h.clients[ev.player]
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.state.Alive {
		return
	}

	curLvl := 0
	switch ev.kind {
	case "hp":
		curLvl = c.state.UpHP
	case "mana":
		curLvl = c.state.UpMana
	case "q":
		curLvl = c.state.UpQ
	case "w":
		curLvl = c.state.UpW
	case "e":
		curLvl = c.state.UpE
	case "r":
		curLvl = c.state.UpR
	case "c":
		curLvl = c.state.UpC
	case "v":
		curLvl = c.state.UpV
	case "x":
		curLvl = c.state.UpX
	default:
		return
	}
	if curLvl >= maxUpgradeForKind(ev.kind) {
		return
	}
	cost := upgradeCost(ev.kind, curLvl)
	if c.state.Gold < cost {
		return
	}
	c.state.Gold -= cost

	switch ev.kind {
	case "hp":
		c.state.UpHP++
		c.state.MaxHP += hpUpgradeDelta
		c.state.HP += hpUpgradeDelta
		if c.state.HP > c.state.MaxHP {
			c.state.HP = c.state.MaxHP
		}
	case "mana":
		c.state.UpMana++
		c.state.MaxMana += manaUpgradeDelta
		c.state.Mana += manaUpgradeDelta
		if c.state.Mana > c.state.MaxMana {
			c.state.Mana = c.state.MaxMana
		}
	case "q":
		c.state.UpQ++
	case "w":
		c.state.UpW++
	case "e":
		c.state.UpE++
	case "r":
		c.state.UpR++
	case "c":
		c.state.UpC++
	case "v":
		c.state.UpV++
	case "x":
		c.state.UpX++
	}
}

func maxUpgradeForKind(kind string) int {
	if kind == "hp" || kind == "mana" {
		return hpManaUpgradeMax
	}
	return spellUpgradeMax
}

func chargeDamage(level int) int {
	if level <= 0 {
		return 0
	}
	return chargeDamageBase + level*chargeDamageStep
}

func pointSegmentDist2(px, pz, ax, az, bx, bz float64) float64 {
	abx := bx - ax
	abz := bz - az
	apx := px - ax
	apz := pz - az
	ab2 := abx*abx + abz*abz
	if ab2 <= 1e-9 {
		dx := px - ax
		dz := pz - az
		return dx*dx + dz*dz
	}
	t := (apx*abx + apz*abz) / ab2
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	cx := ax + abx*t
	cz := az + abz*t
	dx := px - cx
	dz := pz - cz
	return dx*dx + dz*dz
}

func (h *ArenaHub) applyStunPlayer(id uint64, durMS int64) {
	c, ok := h.clients[id]
	if !ok {
		return
	}
	nowMS := time.Now().UnixMilli()
	c.mu.Lock()
	if c.state.Alive {
		until := nowMS + durMS
		if until > c.state.StunUntil {
			c.state.StunUntil = until
		}
	}
	c.mu.Unlock()
}

func (h *ArenaHub) applyStunNPC(id uint64, durMS int64) {
	n, ok := h.npcs[id]
	if !ok || !n.state.Alive {
		return
	}
	nowMS := time.Now().UnixMilli()
	until := nowMS + durMS
	if until > n.stunUntilMS {
		n.stunUntilMS = until
		n.state.StunUntil = until
	}
}

func (h *ArenaHub) registerProjectileKind(shooter, pid uint64, kind string) {
	if pid == 0 {
		return
	}
	m, ok := h.projKinds[shooter]
	if !ok {
		m = make(map[uint64]string)
		h.projKinds[shooter] = m
	}
	m[pid] = kind
}

func (h *ArenaHub) projectileKind(shooter, pid uint64) string {
	if pid == 0 {
		return ""
	}
	m := h.projKinds[shooter]
	if m == nil {
		return ""
	}
	return m[pid]
}

func (h *ArenaHub) stunExtraFromUpgrade(shooter uint64) int64 {
	c := h.clients[shooter]
	if c == nil {
		return 0
	}
	c.mu.Lock()
	lvl := c.state.UpX
	c.mu.Unlock()
	if lvl <= 0 {
		return 0
	}
	return int64(lvl) * xStunStepMS
}

func (h *ArenaHub) applyHit(ev hitEvent) {
	target, ok := h.clients[ev.target]
	if !ok {
		n, isNPC := h.npcs[ev.target]
		if !isNPC || !n.state.Alive || (n.state.Kind != "pes" && n.state.Kind != "reditel") {
			return
		}
		dmg := ev.dmg
		if dmg <= 0 {
			dmg = hitDamage
		}
		maxNPC := n.state.MaxHP
		if maxNPC <= 0 {
			if n.state.Kind == "reditel" {
				maxNPC = reditelHP
				n.state.MaxHP = reditelHP
			} else {
				maxNPC = dogHP
				n.state.MaxHP = dogHP
			}
		}
		if dmg > maxNPC {
			dmg = maxNPC
		}
		n.state.HP -= dmg
		kind := h.projectileKind(ev.shooter, ev.pid)
		killed := n.state.HP <= 0
		if killed {
			n.state.HP = 0
			n.state.Alive = false
			n.state.StunUntil = 0
			n.state.RespawnT = time.Now().UnixMilli() + npcRespawnMS
			n.state.Say = ""
			n.state.SayUntil = 0
			n.hpAcc = 0
			n.stunUntilMS = 0
			if n.state.Kind == "pes" {
				h.spawnPickup("gold", n.state.X, n.state.Z, true, time.Now())
			} else if n.state.Kind == "reditel" {
				coins := 2 + rand.Intn(4)
				for i := 0; i < coins; i++ {
					ang := rand.Float64() * 2 * math.Pi
					rad := 0.6 + rand.Float64()*1.6
					px := n.state.X + math.Sin(ang)*rad
					pz := n.state.Z + math.Cos(ang)*rad
					h.spawnPickup("gold", px, pz, true, time.Now())
				}
			}
		} else if kind == "x" {
			h.applyStunNPC(ev.target, xStunBaseMS+h.stunExtraFromUpgrade(ev.shooter))
		}
		h.broadcastJSON(sMsg{Type: "hit", Data: sHit{
			Shooter: ev.shooter, Target: ev.target, PID: ev.pid,
			HP: n.state.HP, Killed: killed, T: time.Now().UnixMilli(),
		}})
		return
	}
	target.mu.Lock()
	if !target.state.Alive {
		target.mu.Unlock()
		return
	}
	kind := h.projectileKind(ev.shooter, ev.pid)
	dmg := ev.dmg
	if dmg <= 0 {
		dmg = hitDamage
	}
	maxHP := target.state.MaxHP
	if maxHP <= 0 {
		maxHP = startHP
	}
	if dmg > maxHP {
		dmg = maxHP
	}
	now := time.Now()
	target.state.HP -= dmg
	killed := target.state.HP <= 0
	dropGold := 0
	dropX := target.state.X
	dropZ := target.state.Z
	if killed {
		target.state.HP = 0
		target.state.Alive = false
		target.state.RespawnT = now.UnixMilli() + respawnMS
		target.state.StunUntil = 0
		dropGold = target.state.Gold
		target.state.Gold = 0
	} else if kind == "x" {
		until := now.UnixMilli() + xStunBaseMS + h.stunExtraFromUpgrade(ev.shooter)
		if until > target.state.StunUntil {
			target.state.StunUntil = until
		}
	}
	hp := target.state.HP
	target.mu.Unlock()

	if killed && dropGold > 0 {
		h.spawnPickupValue("gold", dropX, dropZ, true, now, dropGold)
	}

	h.broadcastJSON(sMsg{Type: "hit", Data: sHit{
		Shooter: ev.shooter, Target: ev.target, PID: ev.pid,
		HP: hp, Killed: killed, T: time.Now().UnixMilli(),
	}})

	if killed {
		h.respawnAt[ev.target] = now.UnixMilli() + respawnMS
	}
}

func (h *ArenaHub) sendSnapshot() {
	now := time.Now().UnixMilli()
	players := make([]playerState, 0, len(h.clients))
	for _, c := range h.clients {
		c.mu.Lock()
		players = append(players, c.state)
		c.mu.Unlock()
	}
	pks := make([]pickup, 0, len(h.pickups))
	for _, p := range h.pickups {
		pks = append(pks, *p)
	}
	npcs := make([]npcState, 0, len(h.npcs))
	for _, n := range h.npcs {
		npcs = append(npcs, n.state)
	}
	h.broadcastJSON(sMsg{Type: "snap", Data: sSnapshot{T: now, Players: players, Pickups: pks, Npcs: npcs}})
}

func (h *ArenaHub) broadcastJSON(m sMsg) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	for _, c := range h.clients {
		select {
		case c.send <- b:
		default:
			// drop slow client's queue silently
		}
	}
}

// --- WS handler ---

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func (h *ArenaHub) ServeWS(w http.ResponseWriter, r *http.Request) {
	if len(h.clients) >= maxPlayers {
		http.Error(w, "lobby full", http.StatusServiceUnavailable)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}

	id := h.nextID.Add(1)
	c := &client{
		id:   id,
		hub:  h,
		conn: conn,
		send: make(chan []byte, sendQueueLen),
		state: playerState{
			ID:      id,
			Name:    "player",
			X:       (rand.Float64()*2 - 1) * (mapHalfX - 2),
			Z:       (rand.Float64()*2 - 1) * (mapHalfZ - 2),
			HP:      startHP,
			Mana:    startMana,
			MaxHP:   startHP,
			MaxMana: startMana,
			Gold:    0,
			Alive:   true,
		},
	}

	// Send welcome before registering, so the client knows its id.
	welcome := sMsg{Type: "welcome", Data: sWelcome{
		YouID: id, TickRate: tickRate, HalfX: mapHalfX, HalfZ: mapHalfZ,
		StartHP: startHP, StartMana: startMana, HitDmg: hitDamage, NowMS: time.Now().UnixMilli(),
	}}
	if b, err := json.Marshal(welcome); err == nil {
		_ = conn.WriteMessage(websocket.TextMessage, b)
	}

	h.register <- c

	go c.writeLoop()
	go c.readLoop()
}

func (c *client) writeLoop() {
	pingT := time.NewTicker(30 * time.Second)
	defer pingT.Stop()
	defer c.conn.Close()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-pingT.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *client) readLoop() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(8 * 1024)
	_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var m cMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		switch m.Type {
		case "join":
			var j cJoin
			if err := json.Unmarshal(m.Data, &j); err != nil {
				continue
			}
			name := sanitizeName(j.Name)
			c.mu.Lock()
			c.state.Name = name
			c.mu.Unlock()

		case "state":
			var s cState
			if err := json.Unmarshal(m.Data, &s); err != nil {
				continue
			}
			select {
			case c.hub.stateUpd <- stateUpdate{id: c.id, x: s.X, z: s.Z, facing: s.Facing}:
			default:
			}

		case "fire":
			var f cFire
			if err := json.Unmarshal(m.Data, &f); err != nil {
				continue
			}
			select {
			case c.hub.fireEvt <- fireEvent{shooter: c.id, pid: f.PID, ox: f.OX, oz: f.OZ, dx: f.DX, dz: f.DZ, kind: f.Kind}:
			default:
			}

		case "cast":
			var cc cCast
			if err := json.Unmarshal(m.Data, &cc); err != nil {
				continue
			}
			select {
			case c.hub.castEvt <- castEvent{id: c.id, kind: cc.Kind}:
			default:
			}

		case "pickup":
			var pk cPickup
			if err := json.Unmarshal(m.Data, &pk); err != nil {
				continue
			}
			select {
			case c.hub.pickEvt <- pickEvent{player: c.id, pickup: pk.ID}:
			default:
			}

		case "upgrade":
			var up cUpgrade
			if err := json.Unmarshal(m.Data, &up); err != nil {
				continue
			}
			select {
			case c.hub.upgEvt <- upgradeEvent{player: c.id, kind: up.Kind}:
			default:
			}

		case "hit":
			var h cHit
			if err := json.Unmarshal(m.Data, &h); err != nil {
				continue
			}
			if h.Target == c.id {
				continue // can't claim hits on yourself
			}
			select {
			case c.hub.hitEvt <- hitEvent{shooter: c.id, target: h.Target, pid: h.PID, dmg: h.Dmg}:
			default:
			}
		}
	}
}

func sanitizeName(s string) string {
	out := make([]rune, 0, maxNameLen)
	for _, r := range s {
		if r < 32 || r == 127 {
			continue
		}
		out = append(out, r)
		if len(out) >= maxNameLen {
			break
		}
	}
	if len(out) == 0 {
		return "player"
	}
	return string(out)
}

func pickDifferentLine(lines []string, last string) string {
	if len(lines) == 0 {
		return ""
	}
	if len(lines) == 1 {
		return lines[0]
	}
	idx := rand.Intn(len(lines))
	if lines[idx] != last {
		return lines[idx]
	}
	return lines[(idx+1)%len(lines)]
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
