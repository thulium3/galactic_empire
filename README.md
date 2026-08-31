# Galactic Empire

Turn-based multiplayer space conquest. SAP CAP (Node.js) backend, plain
ES-module/SVG frontend - no build step, no runtime dependencies beyond CAP.
Built using Claude AI.

## Prerequisites
For local setup, only current version of Node.js. 

## Setup

```bash
npm install
npm run deploy      # creates db.sqlite
npm run watch       # http://localhost:4004
npm test            # backend: unit + service + event stream
npm run test:ui     # browser smoke test, needs a running server
```

`test:ui` drives the real UI in headless Chrome with **real mouse input** over the
DevTools protocol. Synthetic `element.click()` does not exercise the same code
path in the browser and has already missed one bug here - keep it that way.

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
| `deleteGame` | `game` | `true` - creator or `gamemaster` only, any status, no undo |
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
| `gameDeleted` | everyone | `game`, `name` - the client returns to the lobby |

Events are queued and only dispatched after the transaction commits, so a client
never sees state a rollback would take back. `MyMessages` stays the fallback for
clients that were disconnected.

```js
const events = new EventSource(`/events?game=${gameId}`)
events.addEventListener('turnResolved', e => render(JSON.parse(e.data)))
events.addEventListener('report', e => showReports(JSON.parse(e.data).messages))
```

## Deployment with Docker

Self-hosted alternative to BTP: one app container plus Postgres, no identity
provider. Players type whatever name they like on the login screen.

```bash
cp .env.example .env         # optional: change the Postgres password
docker compose up -d --build
open http://localhost:4004
```

`docker compose logs -f app` follows the server, `docker compose down` stops it,
`docker compose down -v` also drops the database volume.

| Part | Purpose |
|---|---|
| `app` | CAP backend **and** the static web client - no approuter needed |
| `db` | Postgres 17, data in the named volume `pgdata` |

### There is no authentication

`srv/auth/open-auth.js` takes the username straight from the HTTP Basic header
and grants it the `player` role. Nothing is verified, so anyone can play as
anyone else by typing their name. That is the point of this deployment - do not
put such an instance on the public internet.

`GE_GAMEMASTERS=alice,bob` in `.env` grants those names the `gamemaster` role,
which may start and delete games created by others.

### Profiles

The deployment target is chosen by a CDS profile, not by `NODE_ENV`:

| Profile | Database | Auth | Set by |
|---|---|---|---|
| `development` | sqlite (`db.sqlite`) | mocked users | default |
| `docker` | Postgres | `open-auth.js` | `CDS_ENV=docker` in the `Dockerfile` |
| `btp` | HANA | XSUAA | `CDS_ENV=btp` in `mta.yaml` |

Both deployments build from the same sources: `cds build --production --profile
docker` emits the Postgres artifacts, `--profile btp` the HANA ones.

### Schema changes

The entrypoint runs `cds-deploy` before the server starts. `@cap-js/postgres`
defaults to `schema_evolution: auto`, so this is an incremental migration -
restarting or redeploying the container keeps running games.

### Things to know before exposing it

- **One app container only.** Same reason as on BTP: the turn timer and the SSE
  bus are in-process. `docker compose up --scale app=2` would resolve every turn
  twice.
- **No TLS.** Put a reverse proxy in front if it leaves your LAN.
- **The default Postgres password is `galactic`.** Change it in `.env` before
  the container is reachable from anywhere but localhost.

## Deployment to SAP BTP (Cloud Foundry)

```bash
cf login                     # target the galactic-empire space
cds up
```

### Prerequisite: the HANA instance must be mapped to this space

HDI containers can only be created in a space the HANA Cloud instance is mapped
to. If the instance lives in a different space than the one you deploy to, add
that space once:

BTP Cockpit -> SAP HANA Cloud -> your instance -> Manage Configuration ->
Instance Mapping -> add your org and target space -> save.

This cannot be done from the CLI: `databaseMappings` is a provisioning-only
parameter, so `cf update-service` is rejected. Without the mapping the deploy
fails with *"There is no database available"*.

The MTA creates three modules and two services:

| Part | Purpose |
|---|---|
| `galactic-empire-srv` | CAP backend, HANA-backed |
| `galactic-empire-db-deployer` | HDI deployer for the schema |
| `galactic-empire` | approuter - authentication plus the static web client |
| `galactic-empire-auth` | XSUAA, scopes `player` and `gamemaster` |
| `galactic-empire-db` | HDI container (`hana / hdi-shared`) |

**Assign a role collection before first use.** XSUAA hands out no scopes by
default, so without this every request answers 403:

BTP Cockpit -> Security -> Users -> your user -> assign *Galactic Empire Player*,
or *Galactic Empire Game Master* to also start games created by others.

Assign it in **every identity provider the user can log on with**. This
subaccount has two (`sap.custom` for logon, `sap.default` disabled for it) - a
collection granted only in the unused one has no effect.

**Then log out and back in.** Scopes are written into the token at login; a role
granted afterwards does not reach an existing token, and the approuter session
holds that token for `sessionTimeout` (240 min). `/logout` clears it - which is
why `xs-app.json` must declare a `logout` endpoint. Without that declaration
`/logout` is not a route at all: it falls through to the static catch-all,
returns 404, and the stale session survives. A private window works too.

### Things that would break if changed

- **`instances: 1` is mandatory.** The turn timer and the SSE event bus live in
  the process. A second instance would resolve the same turn twice and only
  reach the players connected to it. Scaling out needs a Redis-backed bus and a
  single scheduler - see `srv/lib/event-bus.js` and `srv/lib/turn-timer.js`.
- **Destination timeout 3600000.** The approuter otherwise cuts the open
  `/events` response after its 30s default and the client reconnect-loops.
- **`/user-api` must be routed before the static catch-all.** The approuter's
  user API is how the client knows it is running behind a router; if the
  catch-all claims it first, the router looks for a file, returns 404, and the
  client concludes it runs locally - and then sends no CSRF token, so every POST
  answers 403 while GETs still work.
- **CSRF.** The approuter protects unsafe methods; the client fetches and
  refreshes the token itself (`app/js/api.js`), and does so regardless of which
  environment it thinks it is in, so a wrong guess cannot break every POST.
  `/events` is exempt - it is a GET.
- **Never probe a protected path to detect the environment.** CAP answers 401
  with `WWW-Authenticate: Basic`, and the browser turns that into a modal login
  dialog that swallows every mouse event on the page - the app looks frozen.
- **Auth differs by environment.** Locally the client sends basic auth against
  CAP's mocked users. Behind the approuter it must not send an `Authorization`
  header at all - the session carries the identity. The client detects which one
  it is via `/user-api/currentUser`, which only the approuter serves.

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
srv/lib/rng.js         seeded PRNG - same seed, same galaxy and same battles
srv/lib/names.js       planet names, player colors
srv/auth/open-auth.js  container deployment: any username, no verification
Dockerfile             app image, multi stage (cds build -> runtime)
docker-compose.yml     app + Postgres
docker/entrypoint.sh   schema deploy, then cds-serve
mta.yaml               BTP deployment descriptor
xs-security.json       XSUAA scopes and role templates
app/router/            approuter: routes, logout, static hosting of app/
test/                  backend tests (*.test.js) + ui-smoke.mjs
```

## Not implemented yet

- Solo play: a game needs at least two players, so a single identity cannot
  start one. No AI opponent either.
- Fleet recall, waypoints, multi-hop routes
- Redis fan-out for the event bus, so the backend could run more than one
  instance (see `event-bus.js` and `instances: 1` in `mta.yaml`)
- Spectator / replay API - the seed makes replays possible, nothing reads it back
