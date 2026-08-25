# Galactic Empire

Turn-based multiplayer space conquest. SAP CAP (Node.js) backend, plain
ES-module/SVG frontend - no build step, no runtime dependencies beyond CAP.

## Setup

```bash
npm install
npm run deploy      # creates db.sqlite
npm run watch       # http://localhost:4004
npm test
```

> The `cds` CLI must run on the same Node.js major version that built `better-sqlite3`.
> If `cds` picks a different one, call it explicitly: `node $(which cds) deploy --to sqlite:db.sqlite`.

Mocked users for local development: `alice`, `bob`, `carol`, `dave` (role `player`)
and `admin` (roles `player`, `gamemaster`). Password is empty.

## Rules implemented

| Topic | Rule |
|---|---|
| Galaxy | `planetCount` planets (default 99) on a torus map - leaving left re-enters right, top wraps to bottom |
| Home planets | Randomly assigned, spread out via farthest-point selection, no natives, production 10 |
| Resources | Global pool per player; every owned planet adds its production each turn |
| Ship building | Costs `shipCost` resources; ships join the garrison at the start of the next turn |
| Movement | Fleets travel `shipSpeed` distance units per turn, ETA fixed at launch, no recall |
| Combat | `attackers x rnd(0.7..1.3)` vs `defenders x (rnd(0.7..1.3) + 0.1)`, loser is wiped out |
| Natives | Static defenders, no growth, no ships |
| Fog of war | Positions always visible; name, owner, production and garrison only after the planet was reached or owned |
| Turn end | All players ready, or `turnLimitSec` elapsed (background timer) |
| Elimination | No planets and no fleets left; last player standing wins |

Turn resolution order: pending ships join garrisons -> planets produce -> fleets arrive
and fight -> intel and reports are written -> counters reset.

Determinism: `seed` drives galaxy generation and all combat rolls (`seed` mixed with
the turn number), so a game can be replayed exactly.

## API

Base path `/odata/v4/game`, all endpoints require role `player`.

### Actions (POST)

| Action | Payload | Returns |
|---|---|---|
| `createGame` | `name`, `planetCount`, `maxPlayers`, `turnLimitSec`, `mapWidth`, `mapHeight`, `shipSpeed`, `shipCost`, `seed` | game UUID (creator joins automatically) |
| `joinGame` | `game`, `name` | player UUID |
| `startGame` | `game` | `true` - creator or `gamemaster` only |
| `sendFleet` | `game`, `origin`, `destination`, `ships` | fleet info incl. `arrivalTurn` |
| `buildShips` | `game`, `planet`, `ships` | remaining resources |
| `endTurn` | `game` | `{turn, resolved, finished, waitingFor}` |

`origin`, `destination` and `planet` are planet **numbers**, not UUIDs.

### Functions (GET)

- `starMap(game=<uuid>)` - the whole map from the caller's point of view
- `route(game=<uuid>,origin=<n>,destination=<n>)` - `{distance, turns}` for UI planning

### Entities (read-only unless noted)

- `Games`, `Participants` - lobby and public player info
- `MyPlayers` - own player incl. resources
- `MyFleets` - own fleets in transit
- `MyMessages` - turn reports, `read` is patchable

### Live events (SSE)

```
GET /events?game=<uuid>
```

Server-Sent Events, server to client only - all player actions still go through
the OData API. Requires the caller to be a player of that game (403 otherwise).
Heartbeat every 25s, browser reconnect hint `retry: 3000`.

| Event | Recipients | Payload |
|---|---|---|
| `connected` | the caller | own player ID, name, color |
| `playerJoined` | everyone in the game | joined player, current/max player count |
| `gameStarted` | everyone | `turn: 1`, `turnDeadline`, player list |
| `playerReady` | everyone | who ended their turn, `waitingFor` |
| `turnResolved` | everyone | new `turn`, `turnDeadline`, `finished`, `winner`, player states |
| `report` | one player | that player's turn messages incl. `planetNumber`, `kind`, `text` |

Events are queued and only dispatched after the transaction commits, so a client
never sees state a rollback would take back. `MyMessages` stays the fallback for
clients that were disconnected.

```js
const events = new EventSource(`/events?game=${gameId}`)
events.addEventListener('turnResolved', e => render(JSON.parse(e.data)))
events.addEventListener('report', e => showReports(JSON.parse(e.data).messages))
```

## Frontend

Open <http://localhost:4004/> - plain ES modules and SVG, no build step, served
straight from `app/`. Log in with any mocked user, create or join a game.

- **Star map**: the whole galaxy on one screen, no zoom or scroll. Planet size
  scales with production, the number is always readable, colors follow ownership -
  grey means unexplored.
- **Torus**: planets on the seam are drawn a second time on the far side, and a
  route leaving one edge is drawn again coming in on the other. Distances stay
  proportional because the aspect ratio is preserved.
- **Hover**: name, owner, production, garrison - only what the player has actually
  scouted, with a warning when the intel is older than the current turn.
- **Orders**: click one of your planets, then a destination. The panel shows
  distance, travel time and arrival turn before you commit.
- **Live**: lobby, ready states, turn results and combat reports arrive over the
  event stream - no polling.

## Example

```bash
G=$(curl -s -u alice: -X POST localhost:4004/odata/v4/game/createGame \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","planetCount":99,"maxPlayers":2,"seed":42}' | jq -r .value)

curl -s -u bob:   -X POST localhost:4004/odata/v4/game/joinGame  -H 'Content-Type: application/json' -d "{\"game\":\"$G\",\"name\":\"Bob\"}"
curl -s -u alice: -X POST localhost:4004/odata/v4/game/startGame -H 'Content-Type: application/json' -d "{\"game\":\"$G\"}"
curl -s -u alice: "localhost:4004/odata/v4/game/starMap(game=$G)"
```

## Layout

```
app/index.html         screens: login, lobby, wait room, game
app/styles.css         dark theme
app/js/api.js          OData client + SSE over fetch
app/js/starmap.js      SVG star map, torus rendering
app/js/app.js          state, orders, live updates
db/schema.cds          persistence model
srv/game-service.cds   player facing API
srv/game-service.js    action handlers, fog of war
srv/server.js          bootstraps the event stream
srv/sse.js             SSE endpoint /events
srv/lib/galaxy.js      map generation, home planet placement
srv/lib/geometry.js    torus distance, travel time
srv/lib/combat.js      battle resolution
srv/lib/turn-engine.js turn resolution
srv/lib/turn-timer.js  turn time limit enforcement
srv/lib/event-bus.js   pub/sub for live events, dispatched after commit
```

## Not implemented yet

- Fleet recall, waypoints, multi-hop routes
- Redis fan-out for the event bus (single instance only today - see `event-bus.js`)
- XSUAA role collections and `mta.yaml` for BTP deployment
- Spectator / replay API
