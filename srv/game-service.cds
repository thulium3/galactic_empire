using { galactic as db } from '../db/schema';

/**
 * Player facing API. Everything a client needs, nothing it must not see:
 * planets are only readable through `starMap`, which applies per player intel.
 */
service GameService @(requires: 'player') {

  /** Lobby / overview. Games are created and driven through actions only. */
  @readonly
  entity Games as projection on db.Games {
    ID, name, status, currentTurn, turnDeadline, turnLimitSec,
    maxPlayers, planetCount, mapWidth, mapHeight, shipSpeed, shipCost, createdAt,
    winner.name as winnerName : String(60),
    players : redirected to Participants
  };

  /** Public player info - no resource counts of other players. */
  @readonly
  entity Participants as projection on db.Players {
    ID, game, name, color, turnDone, eliminated, createdAt
  };

  /** The caller's own player records, including resources. */
  @readonly
  entity MyPlayers as projection on db.Players {
    ID, game, name, color, resources, turnDone, eliminated, homePlanet.number as homePlanetNumber : Integer
  } where user = $user;

  /** The caller's fleets in transit. */
  @readonly
  entity MyFleets as projection on db.Fleets {
    ID, game, ships, departureTurn, arrivalTurn, distance, arrived,
    origin.number as originNumber : Integer,
    origin.name as originName : String(40),
    destination.number as destinationNumber : Integer,
    destination.name as destinationName : String(40)
  } where owner.user = $user and arrived = false;

  /** Turn reports for the caller. */
  entity MyMessages as projection on db.Messages {
    ID, game, turn, kind, text, read,
    planet.number as planetNumber : Integer,
    planet.name as planetName : String(40)
  } where player.user = $user;

  // ---------------------------------------------------------------- types

  type StarPlanet {
    number       : Integer;
    x            : Decimal(9,2);
    y            : Decimal(9,2);
    explored     : Boolean;
    mine         : Boolean;
    name         : String(40);       // null while unexplored
    color        : String(7);        // owner color, native color or unknown grey
    ownerName    : String(60);
    production   : Integer;
    ships        : Integer;
    natives      : Integer;
    pendingShips : Integer;
    lastSeenTurn : Integer;
  }

  type FleetInfo {
    ID            : UUID;
    ships         : Integer;
    originNumber  : Integer;
    targetNumber  : Integer;
    distance      : Decimal(9,2);
    departureTurn : Integer;
    arrivalTurn   : Integer;
  }

  type TurnResult {
    turn       : Integer;
    resolved   : Boolean;   // true if the turn was actually advanced
    finished   : Boolean;
    waitingFor : Integer;   // players who have not submitted yet
  }

  // -------------------------------------------------------------- actions

  /** Creates a game in status LOBBY and joins the caller as first player. */
  action createGame (
    name         : String(60),
    planetCount  : Integer,
    maxPlayers   : Integer,
    turnLimitSec : Integer,
    mapWidth     : Integer,
    mapHeight    : Integer,
    shipSpeed    : Decimal(9,2),
    shipCost     : Integer,
    seed         : Integer
  ) returns UUID;

  /** Joins an open game. Returns the new player ID. */
  action joinGame (game : UUID, name : String(60)) returns UUID;

  /** Generates the galaxy, assigns home planets and starts turn 1. */
  action startGame (game : UUID) returns Boolean;

  /** Dispatches ships from one owned planet to any planet. No recall. */
  action sendFleet (game : UUID, origin : Integer, destination : Integer, ships : Integer) returns FleetInfo;

  /** Buys ships; they are stationed on the planet at the start of the next turn. */
  action buildShips (game : UUID, planet : Integer, ships : Integer) returns Integer;

  /** Marks the caller ready. Resolves the turn once everybody is ready. */
  action endTurn (game : UUID) returns TurnResult;

  /** Star map from the caller's point of view. */
  function starMap (game : UUID) returns array of StarPlanet;

  /** Distance and travel time between two planets, for UI planning. */
  function route (game : UUID, origin : Integer, destination : Integer) returns {
    distance : Decimal(9,2);
    turns    : Integer;
  };
}
