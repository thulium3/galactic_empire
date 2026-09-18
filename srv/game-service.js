'use strict'

const cds = require('@sap/cds')
const { generateGalaxy, assignHomePlanets } = require('./lib/galaxy')
const { torusDistance, travelTurns } = require('./lib/geometry')
const { resolveTurn } = require('./lib/turn-engine')
const { PLAYER_COLORS, NATIVE_COLOR, UNKNOWN_COLOR, DESTROYED_COLOR } = require('./lib/names')
const { startTurnTimer } = require('./lib/turn-timer')
const { publish } = require('./lib/event-bus')

module.exports = class GameService extends cds.ApplicationService {

  async init () {
    this.on('createGame', req => this.onCreateGame(req))
    this.on('joinGame', req => this.onJoinGame(req))
    this.on('startGame', req => this.onStartGame(req))
    this.on('deleteGame', req => this.onDeleteGame(req))
    this.on('sendFleet', req => this.onSendFleet(req))
    this.on('buildShips', req => this.onBuildShips(req))
    this.on('endTurn', req => this.onEndTurn(req))
    this.on('starMap', req => this.onStarMap(req))
    this.on('route', req => this.onRoute(req))

    startTurnTimer()
    await super.init()
  }

  // ------------------------------------------------------------- lobby

  async onCreateGame (req) {
    const { Games } = cds.entities('galactic')
    const {
      name, planetCount = 99, maxPlayers = 8, turnLimitSec = 300,
      mapWidth = 1000, mapHeight = 1000, shipSpeed = 120, shipCost = 10,
      planetDrift = 5, starBirthChance = 0, supernovaChance = 0, diversionChance = 0, seed
    } = req.data

    if (!name) return req.reject(400, 'Game name is required')
    if (planetCount < 4 || planetCount > 150) return req.reject(400, 'planetCount must be between 4 and 150')
    if (maxPlayers < 2 || maxPlayers > PLAYER_COLORS.length) {
      return req.reject(400, `maxPlayers must be between 2 and ${PLAYER_COLORS.length}`)
    }
    if (maxPlayers > planetCount) return req.reject(400, 'More players than planets')
    // A planet that outruns a fleet can never be reached.
    if (planetDrift < 0) return req.reject(400, 'planetDrift cannot be negative')
    if (Number(planetDrift) >= Number(shipSpeed)) {
      return req.reject(400, 'planetDrift must stay below shipSpeed - planets would outrun every fleet')
    }
    const badChance = this.invalidChance({ starBirthChance, supernovaChance, diversionChance })
    if (badChance) return req.reject(400, `${badChance} must be a probability between 0 and 1`)

    const ID = cds.utils.uuid()
    await INSERT.into(Games).entries({
      ID,
      name,
      status: 'LOBBY',
      currentTurn: 0,
      turnLimitSec,
      maxPlayers,
      planetCount,
      mapWidth,
      mapHeight,
      shipSpeed,
      shipCost,
      planetDrift,
      starBirthChance,
      supernovaChance,
      diversionChance,
      seed: seed ?? Math.floor(Math.random() * 0x7fffffff)
    })

    await this.addPlayer(req, ID, req.user.id)
    return ID
  }

  async onJoinGame (req) {
    const game = await this.loadGame(req, { status: 'LOBBY' })
    if (!game) return
    return this.addPlayer(req, game.ID, req.user.id, req.data.name)
  }

  async addPlayer (req, gameId, user, displayName) {
    const { Games, Players } = cds.entities('galactic')
    const game = await SELECT.one.from(Games).where({ ID: gameId })
    const players = await SELECT.from(Players).where({ game_ID: gameId }).orderBy('createdAt')

    if (players.some(p => p.user === user)) return req.reject(400, 'You already joined this game')
    if (players.length >= game.maxPlayers) return req.reject(400, 'Game is full')

    const ID = cds.utils.uuid()
    const name = displayName || user
    const color = PLAYER_COLORS[players.length]
    await INSERT.into(Players).entries({
      ID, game_ID: gameId, user, name, color, turnDone: false, eliminated: false
    })

    publish(gameId, 'playerJoined', {
      game: gameId,
      name,
      color,
      players: players.length + 1,
      maxPlayers: game.maxPlayers
    })
    return ID
  }

  async onStartGame (req) {
    const { Games, Players, Planets, PlanetIntel, Messages } = cds.entities('galactic')
    const game = await this.loadGame(req, { status: 'LOBBY' })
    if (!game) return

    const players = await SELECT.from(Players).where({ game_ID: game.ID }).orderBy('createdAt')
    if (players.length < 2) return req.reject(400, 'At least 2 players are required')
    if (players[0].user !== req.user.id && !req.user.is('gamemaster')) {
      return req.reject(403, 'Only the game creator can start the game')
    }

    const generated = generateGalaxy({
      planetCount: game.planetCount,
      mapWidth: game.mapWidth,
      mapHeight: game.mapHeight,
      planetDrift: game.planetDrift,
      seed: game.seed
    })
    const homes = assignHomePlanets(generated, players.length, {
      mapWidth: game.mapWidth,
      mapHeight: game.mapHeight,
      seed: game.seed
    })

    const rows = generated.map(p => ({
      ...p, ID: cds.utils.uuid(), game_ID: game.ID, ships: 0, pendingShips: 0, resources: 0, owner_ID: null
    }))
    const byNumber = new Map(rows.map(r => [r.number, r]))

    players.forEach((player, index) => {
      const home = byNumber.get(homes[index].number)
      home.owner_ID = player.ID
      home.ships = game.startShips
      home.natives = 0
      player.homePlanet_ID = home.ID
    })

    const intel = []
    const messages = []
    for (const player of players) {
      const home = rows.find(r => r.ID === player.homePlanet_ID)
      home.resources = game.startResources
      intel.push({
        player_ID: player.ID,
        planet_ID: home.ID,
        lastSeenTurn: 1,
        knownName: home.name,
        knownOwner_ID: player.ID,
        knownOwnerColor: player.color,
        knownProduction: home.production,
        knownShips: home.ships,
        knownNatives: 0
      })
      messages.push({
        game_ID: game.ID,
        player_ID: player.ID,
        turn: 1,
        kind: 'SYSTEM',
        planet_ID: home.ID,
        text: `Your empire starts on ${home.name} (#${home.number}) with ${game.startShips} ships and ${game.startResources} resources stockpiled there.`,
        read: false
      })
      await UPDATE(Players, player.ID).with({
        homePlanet_ID: player.homePlanet_ID,
        turnDone: false
      })
    }
    await INSERT.into(Planets).entries(rows)
    await INSERT.into(PlanetIntel).entries(intel)
    await INSERT.into(Messages).entries(messages)

    const turnDeadline = new Date(Date.now() + game.turnLimitSec * 1000).toISOString()
    await UPDATE(Games, game.ID).with({ status: 'RUNNING', currentTurn: 1, turnDeadline })

    publish(game.ID, 'gameStarted', {
      game: game.ID,
      turn: 1,
      turnDeadline,
      players: players.map(p => ({ name: p.name, color: p.color }))
    })
    return true
  }

  /**
   * Wipes a game and all its dependents. Works in every status - a running
   * game is abandoned, not finished. Only the creator or a gamemaster may do
   * this, and there is no undo.
   */
  async onDeleteGame (req) {
    const { Games, Players, Planets, PlanetIntel, Fleets, Messages } = cds.entities('galactic')
    const game = await this.loadGame(req)
    if (!game) return

    if (game.createdBy !== req.user.id && !req.user.is('gamemaster')) {
      return req.reject(403, 'Only the game creator can delete this game')
    }

    const players = await SELECT.from(Players).columns('ID').where({ game_ID: game.ID })
    const playerIds = players.map(p => p.ID)

    // Children first, then the game: the associations are not all compositions,
    // so we cannot rely on a cascading deep delete here.
    await DELETE.from(Messages).where({ game_ID: game.ID })
    await DELETE.from(Fleets).where({ game_ID: game.ID })
    if (playerIds.length) await DELETE.from(PlanetIntel).where({ player_ID: playerIds })
    await DELETE.from(Planets).where({ game_ID: game.ID })
    // The winner reference points at a player we are about to remove.
    if (game.winner_ID) await UPDATE(Games, game.ID).with({ winner_ID: null })
    await DELETE.from(Players).where({ game_ID: game.ID })
    await DELETE.from(Games).where({ ID: game.ID })

    publish(game.ID, 'gameDeleted', { game: game.ID, name: game.name })
    return true
  }

  // ------------------------------------------------------------ actions

  async onSendFleet (req) {
    const { Planets, Fleets } = cds.entities('galactic')
    const context = await this.loadContext(req)
    if (!context) return
    const { game, player } = context
    const { origin, destination, ships } = req.data

    if (!Number.isInteger(ships) || ships < 1) return req.reject(400, 'ships must be a positive integer')
    if (origin === destination) return req.reject(400, 'Origin and destination must differ')

    const from = await this.planetByNumber(req, game.ID, origin)
    const to = await this.planetByNumber(req, game.ID, destination)
    if (!from || !to) return

    if (from.owner_ID !== player.ID) return req.reject(403, `Planet #${origin} is not yours`)
    if (from.ships < ships) return req.reject(400, `Only ${from.ships} ships stationed on planet #${origin}`)

    const distance = torusDistance(from, to, game.mapWidth, game.mapHeight)
    const turns = travelTurns(distance, Number(game.shipSpeed))
    const arrivalTurn = game.currentTurn + turns
    const ID = cds.utils.uuid()

    await UPDATE(Planets, from.ID).with({ ships: from.ships - ships })
    await INSERT.into(Fleets).entries({
      ID,
      game_ID: game.ID,
      owner_ID: player.ID,
      origin_ID: from.ID,
      destination_ID: to.ID,
      ships,
      departureTurn: game.currentTurn,
      arrivalTurn,
      distance: Math.round(distance * 100) / 100,
      arrived: false
    })

    return {
      ID,
      ships,
      originNumber: from.number,
      targetNumber: to.number,
      distance: Math.round(distance * 100) / 100,
      departureTurn: game.currentTurn,
      arrivalTurn
    }
  }

  async onBuildShips (req) {
    const { Planets } = cds.entities('galactic')
    const context = await this.loadContext(req)
    if (!context) return
    const { game, player } = context
    const { planet: planetNumber, ships } = req.data

    if (!Number.isInteger(ships) || ships < 1) return req.reject(400, 'ships must be a positive integer')

    const planet = await this.planetByNumber(req, game.ID, planetNumber)
    if (!planet) return
    if (planet.owner_ID !== player.ID) return req.reject(403, `Planet #${planetNumber} is not yours`)

    // A planet pays for its own shipyard. Resources cannot be moved between
    // planets, so a rich neighbour is of no help here.
    const cost = ships * game.shipCost
    if (planet.resources < cost) {
      return req.reject(400,
        `Not enough resources on planet #${planetNumber}: ${cost} required, ${planet.resources} available`)
    }

    const left = planet.resources - cost
    await UPDATE(Planets, planet.ID).with({
      resources: left,
      pendingShips: planet.pendingShips + ships
    })
    return left
  }

  async onEndTurn (req) {
    const { Games, Players } = cds.entities('galactic')
    const context = await this.loadContext(req, { allowTurnDone: true })
    if (!context) return
    const { game, player } = context

    await UPDATE(Players, player.ID).with({ turnDone: true })

    const players = await SELECT.from(Players).where({ game_ID: game.ID })
    const pending = players.filter(p => !p.eliminated && !p.turnDone && p.ID !== player.ID)
    if (pending.length > 0) {
      publish(game.ID, 'playerReady', {
        game: game.ID,
        turn: game.currentTurn,
        name: player.name,
        color: player.color,
        waitingFor: pending.length
      })
      return { turn: game.currentTurn, resolved: false, finished: false, waitingFor: pending.length }
    }

    const result = await resolveTurn(game)
    const after = await SELECT.one.from(Games).where({ ID: game.ID })
    return { turn: after.currentTurn, resolved: true, finished: result.finished, waitingFor: 0 }
  }

  // -------------------------------------------------------------- reads

  async onStarMap (req) {
    const { Planets, Players, PlanetIntel } = cds.entities('galactic')
    const game = await this.loadGame(req)
    if (!game) return

    const player = await SELECT.one.from(Players).where({ game_ID: game.ID, user: req.user.id })
    const [planets, intel, players] = await Promise.all([
      SELECT.from(Planets).where({ game_ID: game.ID }).orderBy('number'),
      player ? SELECT.from(PlanetIntel).where({ player_ID: player.ID }) : [],
      SELECT.from(Players).where({ game_ID: game.ID })
    ])
    const intelByPlanet = new Map(intel.map(i => [i.planet_ID, i]))
    const playersById = new Map(players.map(p => [p.ID, p]))

    return planets.map(planet => {
      // A burnt out star keeps its dot so the routes leading there still make
      // sense, but it is no longer anybody's and holds nothing worth reporting.
      if (planet.destroyed) {
        const seen = intelByPlanet.get(planet.ID)
        return {
          ...this.blankPlanet(planet),
          explored: !!seen,
          destroyed: true,
          name: seen?.knownName ?? null,
          color: DESTROYED_COLOR,
          lastSeenTurn: seen?.lastSeenTurn ?? null
        }
      }

      const mine = !!player && planet.owner_ID === player.ID
      // Own planets are always shown live - garrison changes during the turn.
      if (mine) {
        return {
          number: planet.number,
          x: planet.x,
          y: planet.y,
          explored: true,
          mine: true,
          name: planet.name,
          color: player.color,
          ownerName: player.name,
          production: planet.production,
          resources: planet.resources,
          ships: planet.ships,
          natives: 0,
          pendingShips: planet.pendingShips,
          lastSeenTurn: game.currentTurn,
          destroyed: false
        }
      }

      const known = intelByPlanet.get(planet.ID)
      if (!known) return this.blankPlanet(planet)

      const owner = known.knownOwner_ID ? playersById.get(known.knownOwner_ID) : null
      return {
        number: planet.number,
        x: planet.x,
        y: planet.y,
        explored: true,
        mine: false,
        name: known.knownName,
        color: known.knownOwnerColor ?? (known.knownNatives > 0 ? NATIVE_COLOR : UNKNOWN_COLOR),
        ownerName: owner?.name ?? (known.knownNatives > 0 ? 'Natives' : null),
        production: known.knownProduction,
        resources: null, // never disclosed for a planet that is not yours
        ships: known.knownShips,
        natives: known.knownNatives,
        pendingShips: null,
        lastSeenTurn: known.lastSeenTurn,
        destroyed: false
      }
    })
  }

  async onRoute (req) {
    const game = await this.loadGame(req)
    if (!game) return
    const from = await this.planetByNumber(req, game.ID, req.data.origin)
    const to = await this.planetByNumber(req, game.ID, req.data.destination)
    if (!from || !to) return

    const distance = torusDistance(from, to, game.mapWidth, game.mapHeight)
    return {
      distance: Math.round(distance * 100) / 100,
      turns: travelTurns(distance, Number(game.shipSpeed))
    }
  }

  // ------------------------------------------------------------ helpers

  /** Position and number only - what every player sees of an unknown star. */
  blankPlanet (planet) {
    return {
      number: planet.number,
      x: planet.x,
      y: planet.y,
      explored: false,
      mine: false,
      name: null,
      color: UNKNOWN_COLOR,
      ownerName: null,
      production: null,
      resources: null,
      ships: null,
      natives: null,
      pendingShips: null,
      lastSeenTurn: null,
      destroyed: false
    }
  }

  /** Name of the first special rule probability that is out of range, else null. */
  invalidChance (chances) {
    for (const [name, value] of Object.entries(chances)) {
      const chance = Number(value)
      if (!Number.isFinite(chance) || chance < 0 || chance > 1) return name
    }
    return null
  }

  async loadGame (req, filter = {}) {
    const { Games } = cds.entities('galactic')
    const game = await SELECT.one.from(Games).where({ ID: req.data.game })
    if (!game) return req.reject(404, 'Game not found')
    if (filter.status && game.status !== filter.status) {
      return req.reject(400, `Game is in status ${game.status}, expected ${filter.status}`)
    }
    return game
  }

  /** Loads game + player and enforces the common action preconditions. */
  async loadContext (req, { allowTurnDone = false } = {}) {
    const { Players } = cds.entities('galactic')
    const game = await this.loadGame(req, { status: 'RUNNING' })
    if (!game) return

    const player = await SELECT.one.from(Players).where({ game_ID: game.ID, user: req.user.id })
    if (!player) return req.reject(403, 'You are not part of this game')
    if (player.eliminated) return req.reject(403, 'You have been eliminated')
    if (player.turnDone && !allowTurnDone) return req.reject(400, 'You already ended your turn')
    return { game, player }
  }

  async planetByNumber (req, gameId, number) {
    const { Planets } = cds.entities('galactic')
    const planet = await SELECT.one.from(Planets).where({ game_ID: gameId, number })
    if (!planet) return req.reject(404, `Planet #${number} not found`)
    // A remnant is still a row, but nothing can be sent there, built there or
    // routed through it.
    if (planet.destroyed) return req.reject(400, `Planet #${number} was wiped out by a supernova`)
    return planet
  }
}
