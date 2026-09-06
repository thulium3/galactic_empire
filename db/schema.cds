namespace galactic;

using { cuid, managed } from '@sap/cds/common';

type GameStatus  : String(10) enum { LOBBY; RUNNING; FINISHED; };
type MessageKind : String(20) enum { ARRIVAL; COMBAT; CAPTURE; LOSS; SYSTEM; };

/**
 * A single match. Holds all rules and the turn clock.
 */
entity Games : cuid, managed {
  name          : String(60)     not null;
  status        : GameStatus     default 'LOBBY';
  currentTurn   : Integer        default 0;
  turnDeadline  : Timestamp;
  turnLimitSec  : Integer        default 300;   // hard time limit per turn
  maxPlayers    : Integer        default 8;
  planetCount   : Integer        default 99;
  mapWidth      : Integer        default 1000;  // torus width  (wraps around)
  mapHeight     : Integer        default 1000;  // torus height (wraps around)
  shipSpeed     : Decimal(9, 2)  default 120;   // distance units travelled per turn
  shipCost      : Integer        default 10;    // resources per ship
  planetDrift   : Decimal(9, 2)  default 5;     // max units a planet drifts per turn, 0 = static galaxy
  startResources: Integer        default 100;
  startShips    : Integer        default 20;
  seed          : Integer;                      // deterministic galaxy + combat rolls
  winner        : Association to Players;

  players  : Composition of many Players  on players.game  = $self;
  planets  : Composition of many Planets  on planets.game  = $self;
  fleets   : Composition of many Fleets   on fleets.game   = $self;
  messages : Composition of many Messages on messages.game = $self;
}

/**
 * A participant. `user` maps to the authenticated principal.
 */
entity Players : cuid, managed {
  game       : Association to Games not null;
  user       : String(80) not null;             // req.user.id
  name       : String(60) not null;
  color      : String(7)  not null;             // #rrggbb, unique per game
  turnDone   : Boolean default false;           // submitted actions for current turn
  eliminated : Boolean default false;
  homePlanet : Association to Planets;

  planets : Association to many Planets on planets.owner = $self;
  fleets  : Association to many Fleets  on fleets.owner  = $self;
  intel   : Composition of many PlanetIntel on intel.player = $self;
}

/**
 * A star system. `owner` null + natives > 0 => held by natives,
 * `owner` null + natives = 0 => empty.
 *
 * Every planet runs its own economy: `production` accrues into `resources` on
 * this planet each turn, and ships can only be built here from that stockpile.
 * There is no empire-wide treasury and no way to move resources.
 *
 * Planets drift: `x`/`y` advance by `vx`/`vy` every turn and wrap around the
 * torus. The velocity is fixed for the lifetime of the planet.
 */
entity Planets : cuid, managed {
  game         : Association to Games not null;
  number       : Integer not null;              // display number on the star map
  name         : String(40) not null;
  x            : Decimal(9, 2) not null;
  y            : Decimal(9, 2) not null;
  vx           : Decimal(9, 2) default 0;       // drift per turn, x axis
  vy           : Decimal(9, 2) default 0;       // drift per turn, y axis
  production   : Integer default 0;             // resources per turn, this planet only
  resources    : Integer default 0;             // stockpile, spendable only here
  owner        : Association to Players;
  natives      : Integer default 0;             // defenders when unowned
  ships        : Integer default 0;             // stationed ships of the owner
  pendingShips : Integer default 0;             // built this turn, available next turn
}

/**
 * Ships in transit. Immutable once dispatched - no recall, no re-routing.
 */
entity Fleets : cuid, managed {
  game          : Association to Games   not null;
  owner         : Association to Players not null;
  origin        : Association to Planets not null;
  destination   : Association to Planets not null;
  ships         : Integer not null;
  departureTurn : Integer not null;
  arrivalTurn   : Integer not null;
  distance      : Decimal(9, 2);
  arrived       : Boolean default false;
}

/**
 * What a player knows about a planet. Written whenever the player
 * owns the planet or one of his fleets reaches it.
 */
entity PlanetIntel : cuid {
  player          : Association to Players not null;
  planet          : Association to Planets not null;
  lastSeenTurn    : Integer;
  knownName       : String(40);
  knownOwner      : Association to Players;
  knownOwnerColor : String(7);
  knownProduction : Integer;
  knownShips      : Integer;
  knownNatives    : Integer;
}

/**
 * Turn report entries, one per event and player.
 */
entity Messages : cuid {
  game   : Association to Games   not null;
  player : Association to Players not null;
  turn   : Integer not null;
  kind   : MessageKind;
  planet : Association to Planets;
  text   : String(500);
  read   : Boolean default false;
}
