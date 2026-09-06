'use strict'

const cds = require('@sap/cds')
const { createRng, mixSeed } = require('./rng')
const { driftPosition } = require('./geometry')
const { resolveBattle } = require('./combat')
const { publish } = require('./event-bus')

/**
 * Advances a game by one turn:
 *   1. every planet drifts one step along its own velocity
 *   2. ships built last turn become available
 *   3. every owned planet produces into its own stockpile
 *   4. arriving fleets land, fight and capture
 *   5. intel is refreshed, turn reports are written
 *   6. turn counter, deadline and ready flags are reset
 *
 * Runs inside the caller's transaction.
 */
async function resolveTurn (game) {
  const { Games, Players, Planets, Fleets, Messages } = cds.entities('galactic')
  const nextTurn = game.currentTurn + 1
  const rng = createRng(mixSeed(game.seed ?? 1, nextTurn))

  const [players, planets, incoming] = await Promise.all([
    SELECT.from(Players).where({ game_ID: game.ID }),
    SELECT.from(Planets).where({ game_ID: game.ID }),
    SELECT.from(Fleets).where({ game_ID: game.ID, arrived: false }).and('arrivalTurn <=', nextTurn).orderBy('ID')
  ])

  const planetsById = new Map(planets.map(p => [p.ID, p]))
  const playersById = new Map(players.map(p => [p.ID, p]))
  const messages = []
  const seenBy = new Map(players.map(p => [p.ID, new Set()]))

  // The galaxy rearranges itself first, so everything else in this turn - and
  // every position reported afterwards - uses the new coordinates. A fleet
  // tracks its target planet, so this never changes an arrival turn.
  for (const planet of planets) {
    const moved = driftPosition(planet, game.mapWidth, game.mapHeight)
    if (moved.x !== Number(planet.x) || moved.y !== Number(planet.y)) {
      planet.x = moved.x
      planet.y = moved.y
      planet.dirty = true
    }
  }

  // Ships ordered last turn join the garrison before the enemy arrives,
  // and planets pay out for the turn they were held - not for the one they are lost in.
  for (const planet of planets) {
    if (planet.pendingShips > 0) {
      planet.ships += planet.pendingShips
      planet.pendingShips = 0
      planet.dirty = true
    }
    if (planet.owner_ID) {
      const owner = playersById.get(planet.owner_ID)
      if (owner) {
        // Production stays where it is produced - there is no empire treasury.
        planet.resources += planet.production
        planet.dirty = true
        seenBy.get(owner.ID).add(planet.ID)
      }
    }
  }

  resolveArrivals({ incoming, planetsById, playersById, rng, nextTurn, messages, seenBy, game })

  await persistPlanets(planets)
  await markFleetsArrived(incoming)
  await refreshIntel({ seenBy, planetsById, playersById, turn: nextTurn })

  const inTransit = await SELECT.from(Fleets).columns('owner_ID').where({ game_ID: game.ID, arrived: false })
  const withFleets = new Set(inTransit.map(f => f.owner_ID))
  const withPlanets = new Set(planets.filter(p => p.owner_ID).map(p => p.owner_ID))

  for (const player of players) {
    if (player.eliminated) continue
    if (withPlanets.has(player.ID) || withFleets.has(player.ID)) continue
    player.eliminated = true
    player.dirty = true
    messages.push(message(game, player, nextTurn, 'SYSTEM', null, 'Your empire has fallen. You are eliminated.'))
  }

  await persistPlayers(players)
  if (messages.length) await INSERT.into(Messages).entries(messages)

  const survivors = players.filter(p => !p.eliminated)
  const finished = survivors.length <= 1
  const turnDeadline = new Date(Date.now() + game.turnLimitSec * 1000).toISOString()
  await UPDATE(Games, game.ID).with({
    currentTurn: nextTurn,
    turnDeadline,
    status: finished ? 'FINISHED' : 'RUNNING',
    winner_ID: finished && survivors.length === 1 ? survivors[0].ID : null
  })

  pushTurnEvents({ game, players, playersById, planetsById, messages, nextTurn, turnDeadline, finished, survivors })
  return { turn: nextTurn, finished, events: messages.length }
}

/** Pushes the new turn to everyone and the personal report to each player. */
function pushTurnEvents ({ game, players, playersById, planetsById, messages, nextTurn, turnDeadline, finished, survivors }) {
  for (const [playerId, own] of groupBy(messages, m => m.player_ID)) {
    const player = playersById.get(playerId)
    if (!player) continue
    publish(game.ID, 'report', {
      turn: nextTurn,
      messages: own.map(m => {
        const planet = m.planet_ID ? planetsById.get(m.planet_ID) : null
        return {
          kind: m.kind,
          text: m.text,
          planetNumber: planet?.number ?? null,
          planetName: planet?.name ?? null
        }
      })
    }, player.user)
  }

  publish(game.ID, 'turnResolved', {
    game: game.ID,
    turn: nextTurn,
    turnDeadline,
    finished,
    winner: finished && survivors.length === 1 ? survivors[0].name : null,
    players: players.map(p => ({ name: p.name, color: p.color, eliminated: p.eliminated }))
  })
}

/** Lands all fleets due this turn, one planet at a time. */
function resolveArrivals ({ incoming, planetsById, playersById, rng, nextTurn, messages, seenBy, game }) {
  const byPlanet = groupBy(incoming, f => f.destination_ID)

  for (const [planetId, fleets] of byPlanet) {
    const planet = planetsById.get(planetId)
    if (!planet) continue

    // Fleets of the same player arriving together fight as one force.
    const byPlayer = [...groupBy(fleets, f => f.owner_ID)].sort((a, b) => String(a[0]).localeCompare(String(b[0])))

    for (const [playerId, playerFleets] of byPlayer) {
      const player = playersById.get(playerId)
      if (!player) continue
      const ships = playerFleets.reduce((sum, f) => sum + f.ships, 0)
      seenBy.get(playerId).add(planet.ID)
      planet.dirty = true

      if (planet.owner_ID === playerId) {
        planet.ships += ships
        messages.push(message(game, player, nextTurn, 'ARRIVAL', planet,
          `${ships} ships arrived at ${planet.name} (#${planet.number}). Garrison: ${planet.ships}.`))
        continue
      }

      const defenderId = planet.owner_ID
      const defenders = defenderId ? planet.ships : planet.natives
      const defenderLabel = defenderId ? playersById.get(defenderId)?.name ?? 'the enemy' : 'the natives'

      if (defenders === 0) {
        capture(planet, playerId, ships)
        messages.push(message(game, player, nextTurn, 'CAPTURE', planet,
          `${planet.name} (#${planet.number}) was undefended and is now yours. Garrison: ${ships}.`))
        if (defenderId) {
          seenBy.get(defenderId).add(planet.ID)
          messages.push(message(game, playersById.get(defenderId), nextTurn, 'LOSS', planet,
            `You lost ${planet.name} (#${planet.number}) to ${player.name} - the planet was undefended.`))
        }
        continue
      }

      const battle = resolveBattle(ships, defenders, rng)
      const detail = `${battle.attackers} attackers (x${battle.attackFactor}) vs ${battle.defenders} defenders (x${battle.defenseFactor})`

      if (battle.attackerWins) {
        capture(planet, playerId, battle.survivors)
        messages.push(message(game, player, nextTurn, 'CAPTURE', planet,
          `You captured ${planet.name} (#${planet.number}) from ${defenderLabel}. ${detail}. ${battle.survivors} ships survived.`))
        if (defenderId) {
          seenBy.get(defenderId).add(planet.ID)
          messages.push(message(game, playersById.get(defenderId), nextTurn, 'LOSS', planet,
            `You lost ${planet.name} (#${planet.number}) to ${player.name}. ${detail}.`))
        }
      } else {
        if (defenderId) planet.ships = battle.survivors
        else planet.natives = battle.survivors
        messages.push(message(game, player, nextTurn, 'COMBAT', planet,
          `Your attack on ${planet.name} (#${planet.number}) failed. ${detail}. ${battle.survivors} defenders remain.`))
        if (defenderId) {
          seenBy.get(defenderId).add(planet.ID)
          messages.push(message(game, playersById.get(defenderId), nextTurn, 'COMBAT', planet,
            `You repelled an attack by ${player.name} on ${planet.name} (#${planet.number}). ${detail}. ${battle.survivors} ships remain.`))
        }
      }
    }
  }
}

/**
 * The stockpile sits on the planet, so whoever holds the planet holds what is
 * stored there: `resources` deliberately survives a capture. Change this line
 * to `planet.resources = 0` if a conquest should raze the depot instead.
 */
function capture (planet, playerId, ships) {
  planet.owner_ID = playerId
  planet.ships = ships
  planet.natives = 0
}

async function persistPlanets (planets) {
  const { Planets } = cds.entities('galactic')
  for (const planet of planets.filter(p => p.dirty)) {
    await UPDATE(Planets, planet.ID).with({
      owner_ID: planet.owner_ID ?? null,
      ships: planet.ships,
      natives: planet.natives,
      pendingShips: planet.pendingShips,
      resources: planet.resources,
      x: planet.x,
      y: planet.y
    })
  }
}

/** Persists elimination and clears the ready flag for the new turn. */
async function persistPlayers (players) {
  const { Players } = cds.entities('galactic')
  for (const player of players) {
    await UPDATE(Players, player.ID).with({
      eliminated: player.eliminated,
      turnDone: false
    })
  }
}

async function markFleetsArrived (fleets) {
  if (!fleets.length) return
  const { Fleets } = cds.entities('galactic')
  await UPDATE(Fleets).set({ arrived: true }).where({ ID: { in: fleets.map(f => f.ID) } })
}

/** Writes/updates what each player learned about the planets he touched. */
async function refreshIntel ({ seenBy, planetsById, playersById, turn }) {
  const { PlanetIntel } = cds.entities('galactic')
  for (const [playerId, planetIds] of seenBy) {
    if (!planetIds.size) continue
    const existing = await SELECT.from(PlanetIntel)
      .where({ player_ID: playerId, planet_ID: { in: [...planetIds] } })
    const byPlanet = new Map(existing.map(i => [i.planet_ID, i]))
    const inserts = []

    for (const planetId of planetIds) {
      const planet = planetsById.get(planetId)
      if (!planet) continue
      const owner = planet.owner_ID ? playersById.get(planet.owner_ID) : null
      const data = {
        lastSeenTurn: turn,
        knownName: planet.name,
        knownOwner_ID: planet.owner_ID ?? null,
        knownOwnerColor: owner?.color ?? null,
        knownProduction: planet.production,
        knownShips: planet.owner_ID ? planet.ships : 0,
        knownNatives: planet.natives
      }
      const row = byPlanet.get(planetId)
      if (row) await UPDATE(PlanetIntel, row.ID).with(data)
      else inserts.push({ player_ID: playerId, planet_ID: planetId, ...data })
    }
    if (inserts.length) await INSERT.into(PlanetIntel).entries(inserts)
  }
}

function message (game, player, turn, kind, planet, text) {
  return {
    game_ID: game.ID,
    player_ID: player.ID,
    turn,
    kind,
    planet_ID: planet?.ID ?? null,
    text,
    read: false
  }
}

function groupBy (items, keyOf) {
  const map = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

module.exports = { resolveTurn }
