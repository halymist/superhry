package main

import (
	"encoding/json"
	"log"
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
	hitDamage    = 40
	respawnMS    = 3000
	mapHalfX     = 25.0
	mapHalfZ     = 15.0
	maxNameLen   = 16
	sendQueueLen = 64
)

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
	Alive    bool    `json:"alive"`
	RespawnT int64   `json:"respawnAt,omitempty"` // unix ms; 0 if alive
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

// --- outbound server messages ---

type sMsg struct {
	Type string      `json:"type"`
	Data interface{} `json:"data,omitempty"`
}

type sWelcome struct {
	YouID    uint64  `json:"youId"`
	TickRate int     `json:"tickRate"`
	HalfX    float64 `json:"halfX"`
	HalfZ    float64 `json:"halfZ"`
	StartHP  int     `json:"startHp"`
	HitDmg   int     `json:"hitDmg"`
	NowMS    int64   `json:"nowMs"`
}

type sSnapshot struct {
	T       int64         `json:"t"` // unix ms
	Players []playerState `json:"players"`
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

	mu    sync.Mutex
	state playerState
}

type ArenaHub struct {
	register   chan *client
	unregister chan *client
	broadcast  chan []byte

	// inbound game events (hub-owned mutations)
	stateUpd chan stateUpdate
	hitEvt   chan hitEvent
	respawn  chan uint64

	clients map[uint64]*client
	nextID  atomic.Uint64
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

func NewArenaHub() *ArenaHub {
	return &ArenaHub{
		register:   make(chan *client, 16),
		unregister: make(chan *client, 16),
		broadcast:  make(chan []byte, 256),
		stateUpd:   make(chan stateUpdate, 1024),
		hitEvt:     make(chan hitEvent, 256),
		respawn:    make(chan uint64, 64),
		clients:    make(map[uint64]*client),
	}
}

func (h *ArenaHub) Run() {
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

		case id := <-h.respawn:
			if c, ok := h.clients[id]; ok {
				c.mu.Lock()
				c.state.HP = startHP
				c.state.Alive = true
				c.state.RespawnT = 0
				c.state.X = (rand.Float64()*2 - 1) * (mapHalfX - 2)
				c.state.Z = (rand.Float64()*2 - 1) * (mapHalfZ - 2)
				c.mu.Unlock()
			}

		case <-ticker.C:
			h.sendSnapshot()
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
	h.broadcastJSON(sMsg{Type: "snap", Data: sSnapshot{T: now, Players: players}})
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
			Alive: true,
		},
	}

	// Send welcome before registering, so the client knows its id.
	welcome := sMsg{Type: "welcome", Data: sWelcome{
		YouID: id, TickRate: tickRate, HalfX: mapHalfX, HalfZ: mapHalfZ,
		StartHP: startHP, HitDmg: hitDamage, NowMS: time.Now().UnixMilli(),
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
			// Server only relays projectiles; clients render them locally.
			c.hub.broadcastJSON(sMsg{Type: "fire", Data: sFire{
				Owner: c.id, PID: f.PID,
				OX: f.OX, OZ: f.OZ, DX: f.DX, DZ: f.DZ,
				Kind: f.Kind,
				T:    time.Now().UnixMilli(),
			}})

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
