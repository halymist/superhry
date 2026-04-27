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
	respawnMS    = 3000
	mapHalfX     = 36.0
	mapHalfZ     = 22.0
	maxNameLen   = 16
	sendQueueLen = 64

	hpRegenPerSec   = 2.0
	manaRegenPerSec = 8.0

	pickupSpawnMS = 9000
	maxPickups    = 2
	pickupAmount  = 20
	pickupRadius  = 1.2 // pickup-collection distance
	pickupLifeMS  = 30000
	npcSayMS      = 4000
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
	}
	return 0
}

type vec2 struct {
	X float64 `json:"x"`
	Z float64 `json:"z"`
}

type playerState struct {
	ID       uint64  `json:"id"`
	Name     string  `json:"name"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
	Facing   float64 `json:"facing"`
	HP       int     `json:"hp"`
	Mana     int     `json:"mana"`
	Alive    bool    `json:"alive"`
	RespawnT int64   `json:"respawnAt,omitempty"` // unix ms; 0 if alive
}

type pickup struct {
	ID        uint64  `json:"id"`
	Kind      string  `json:"kind"` // "hp" or "mana"
	X         float64 `json:"x"`
	Z         float64 `json:"z"`
	SpawnAtMS int64   `json:"spawnAtMs"`
	ExpireMS  int64   `json:"expireAtMs"`
}

type npcState struct {
	ID       uint64  `json:"id"`
	Kind     string  `json:"kind"`
	Name     string  `json:"name"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
	Facing   float64 `json:"facing"`
	Scale    float64 `json:"scale"`
	Say      string  `json:"say,omitempty"`
	SayUntil int64   `json:"sayUntil,omitempty"`
}

type npcRuntime struct {
	state     npcState
	vx        float64
	vz        float64
	nextDirMS int64
	nextSayMS int64
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
	respawn  chan uint64

	clients    map[uint64]*client
	nextID     atomic.Uint64
	pickups    map[uint64]*pickup
	nextPickID atomic.Uint64
	lastPickup time.Time
	lastTick   time.Time
	npcs       map[uint64]*npcRuntime
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
		respawn:    make(chan uint64, 64),
		clients:    make(map[uint64]*client),
		pickups:    make(map[uint64]*pickup),
		lastTick:   time.Now(),
		npcs:       make(map[uint64]*npcRuntime),
	}
}

func (h *ArenaHub) initNPCs() {
	now := time.Now().UnixMilli()
	h.npcs[1001] = &npcRuntime{
		state: npcState{ID: 1001, Kind: "namestek", Name: "namestek", X: -6, Z: 4, Facing: 0, Scale: 1.0},
		nextDirMS: now + 1200,
		nextSayMS: now + 3000,
	}
	h.npcs[1002] = &npcRuntime{
		state: npcState{ID: 1002, Kind: "reditel", Name: "ředitel", X: 10, Z: -8, Facing: 0, Scale: 1.8},
		nextDirMS: now + 900,
		nextSayMS: now + 1000000,
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
				close(c.send)
				h.broadcastJSON(sMsg{Type: "leave", Data: sLeave{ID: c.id}})
			}

		case u := <-h.stateUpd:
			if c, ok := h.clients[u.id]; ok {
				c.mu.Lock()
				if c.state.Alive {
					c.state.X = clamp(u.x, -mapHalfX, mapHalfX)
					c.state.Z = clamp(u.z, -mapHalfZ, mapHalfZ)
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

		case id := <-h.respawn:
			if c, ok := h.clients[id]; ok {
				c.mu.Lock()
				c.state.HP = startHP
				c.state.Mana = startMana
				c.state.Alive = true
				c.state.RespawnT = 0
				c.state.X = (rand.Float64()*2 - 1) * (mapHalfX - 2)
				c.state.Z = (rand.Float64()*2 - 1) * (mapHalfZ - 2)
				c.hpAcc = 0
				c.manaAcc = 0
				c.mu.Unlock()
			}

		case <-ticker.C:
			now := time.Now()
			dt := now.Sub(h.lastTick).Seconds()
			if dt < 0 || dt > 1 {
				dt = 1.0 / float64(tickRate)
			}
			h.lastTick = now
			h.regen(dt)
			h.expirePickups(now)
			h.maybeSpawnPickup(now)
			h.updateNPCs(now, dt)
			h.sendSnapshot()
		}
	}
}

func (h *ArenaHub) updateNPCs(now time.Time, dt float64) {
	nowMS := now.UnixMilli()
	namestekLines := []string{
		"nevite kde je martin",
		"je tady martin",
		"martin?",
		"poslete za mnou martina",
		"hledam martina",
		"nevidel nekdo martina?",
	}

	for _, n := range h.npcs {
		speed := 1.3
		if n.state.Kind == "reditel" {
			speed = 0.9
		}

		if nowMS >= n.nextDirMS {
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
				n.state.Say = namestekLines[rand.Intn(len(namestekLines))]
				n.state.SayUntil = nowMS + npcSayMS
				n.nextSayMS = nowMS + 6000 + int64(rand.Intn(5000))
			} else {
				n.nextSayMS = nowMS + 2500
			}
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
			if c.state.HP < startHP {
				c.hpAcc += hpRegenPerSec * dt
				if c.hpAcc >= 1 {
					add := int(c.hpAcc)
					c.hpAcc -= float64(add)
					c.state.HP += add
					if c.state.HP > startHP {
						c.state.HP = startHP
					}
				}
			} else {
				c.hpAcc = 0
			}
			if c.state.Mana < startMana {
				c.manaAcc += manaRegenPerSec * dt
				if c.manaAcc >= 1 {
					add := int(c.manaAcc)
					c.manaAcc -= float64(add)
					c.state.Mana += add
					if c.state.Mana > startMana {
						c.state.Mana = startMana
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
	kind := "hp"
	if rand.Intn(2) == 0 {
		kind = "mana"
	}
	id := h.nextPickID.Add(1)
	nowMS := now.UnixMilli()
	p := &pickup{
		ID:        id,
		Kind:      kind,
		X:         (rand.Float64()*2 - 1) * (mapHalfX - 2),
		Z:         (rand.Float64()*2 - 1) * (mapHalfZ - 2),
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
	defer c.mu.Unlock()
	if !c.state.Alive {
		return
	}
	if c.state.Mana < cost {
		return
	}
	c.state.Mana -= cost
}

func (h *ArenaHub) applyFire(ev fireEvent) {
	c, ok := h.clients[ev.shooter]
	if !ok {
		return
	}
	cost := manaCost(ev.kind)
	c.mu.Lock()
	if !c.state.Alive || c.state.Mana < cost {
		c.mu.Unlock()
		return
	}
	c.state.Mana -= cost
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
		if c.state.HP > startHP {
			c.state.HP = startHP
		}
	case "mana":
		c.state.Mana += pickupAmount
		if c.state.Mana > startMana {
			c.state.Mana = startMana
		}
	}
}

func (h *ArenaHub) applyHit(ev hitEvent) {
	target, ok := h.clients[ev.target]
	if !ok {
		return
	}
	target.mu.Lock()
	if !target.state.Alive {
		target.mu.Unlock()
		return
	}
	dmg := ev.dmg
	if dmg <= 0 {
		dmg = hitDamage
	}
	if dmg > startHP {
		dmg = startHP
	}
	target.state.HP -= dmg
	killed := target.state.HP <= 0
	if killed {
		target.state.HP = 0
		target.state.Alive = false
		target.state.RespawnT = time.Now().UnixMilli() + respawnMS
	}
	hp := target.state.HP
	target.mu.Unlock()

	h.broadcastJSON(sMsg{Type: "hit", Data: sHit{
		Shooter: ev.shooter, Target: ev.target, PID: ev.pid,
		HP: hp, Killed: killed, T: time.Now().UnixMilli(),
	}})

	if killed {
		id := ev.target
		time.AfterFunc(respawnMS*time.Millisecond, func() {
			select {
			case h.respawn <- id:
			default:
			}
		})
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
			ID:    id,
			Name:  "player",
			X:     (rand.Float64()*2 - 1) * (mapHalfX - 2),
			Z:     (rand.Float64()*2 - 1) * (mapHalfZ - 2),
			HP:    startHP,
			Mana:  startMana,
			Alive: true,
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

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
