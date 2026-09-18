'use strict'

const cds = require('@sap/cds')
const { createRng, mixSeed } = require('./rng')
const { driftPosition } = require('./geometry')
const { resolveBattle } = require('./combat')
const { igniteStar, pickSupernova, divertTarget, divertedArrival } = require('./anomalies')
const { publish } = require('./event-bus')

/**
 * Advances a game by one turn:
 *   1. every planet drifts one step along its own velocity
 *   2. special rules fire - a star may ignite, a star may explode
 *   3. fleets are thrown off course by asteroid fields and dead targets
 *   4. ships built last turn become available
 *   5. every owned planet produces into its own stockpile
 *   6. arriving fleets land, fight and capture
 *   7. intel is refreshed, turn reports are written
 *   8. turn counter, deadline and ready flags are reset
 *
 * Runs inside the caller's transaction.
 */
async function resolveTurn (game) {
  const { Games, Players, Planets, Fleets, Messages } = cds.entities('galactic')
  const nextTurn = game.currentTurn + 1
  const rng = createRng(mixSeed(game.seed ?? 1, nextTurn))

  // Every fleet still flying, not just the ones due this turn: a special rule
  // may push one of them onto a later arrival before the landings are picked.
  const [players, planets, inFlight] = await Promise.all([
    SELECT.from(Players).where({ game_ID: game.ID }),
    SELECT.from(Planets).where({ game_ID: game.ID }),
    SELECT.from(Fleets).where({ game_ID: game.ID, arrived: false }).orderBy('ID')
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

  await resolveStarBirth({ game, planets, planetsById, players, rng, nextTurn, messages })
  await resolveSupernova({ game, planets, players, playersById, rng, nextTurn, messages })
  resolveDiversions({ game, fleets: inFlight, planets, planetsById, playersById, rng, nextTurn, messages })

  const incoming = inFlight.filter(f => !f.lost && f.arrivalTurn <= nextTurn)

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
  await persistFleets(inFlight)
  await markFleetsArrived([...incoming, ...inFlight.filter(f => f.lost)])
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

/**
 * Special rule: a new star may ignite in the void. It shows up on every star
 * map right away - positions are never hidden - but nobody has intel on it, so
 * it is just another grey dot until somebody sends ships.
 */
async function resolveStarBirth ({ game, planets, planetsById, players, rng, nextTurn, messages }) {
  const born = igniteStar({ planets, game, rng })
  if (!born) return

  const { Planets } = cds.entities('galactic')
  const row = {
    ...born,
    ID: cds.utils.uuid(),
    game_ID: game.ID,
    owner_ID: null,
    ships: 0,
    pendingShips: 0,
    resources: 0
  }
  await INSERT.into(Planets).entries(row)

  // Part of the galaxy from here on - later phases of this turn see it too.
  const planet = { ...row, dirty: false }
  planets.push(planet)
  planetsById.set(planet.ID, planet)

  for (const player of players) {
    if (player.eliminated) continue
    messages.push(message(game, player, nextTurn, 'STARBIRTH', planet,
      `A new star ignited in the void: #${planet.number}. Nobody has been there yet.`))
  }
}

/**
 * Special rule: a supernova wipes a star off the map. Every star is fair game,
 * home worlds included - garrison, natives and stockpile burn with it.
 *
 * The row survives as a burnt out remnant: fleets, intel and old turn reports
 * still point at it, and a fleet already on its way needs a wreck to be
 * diverted away from.
 */
async function resolveSupernova ({ game, planets, players, playersById, rng, nextTurn, messages }) {
  const doomed = pickSupernova({ planets, game, rng })
  if (!doomed) return null

  const owner = doomed.owner_ID ? playersById.get(doomed.owner_ID) : null
  const lostShips = doomed.owner_ID ? doomed.ships : doomed.natives
  const lostResources = doomed.resources

  Object.assign(doomed, {
    destroyed: true,
    owner_ID: null,
    ships: 0,
    natives: 0,
    pendingShips: 0,
    resources: 0,
    production: 0,
    vx: 0,
    vy: 0,
    dirty: true
  })

  // The flash is seen galaxy wide, the name is not: a commander who never
  // scouted that star only learns that something out there went up.
  const knowsIt = await playersKnowing(doomed, owner)
  for (const player of players) {
    if (player.eliminated) continue
    const label = knowsIt.has(player.ID) ? `${doomed.name} (#${doomed.number})` : `#${doomed.number}`
    messages.push(message(game, player, nextTurn, 'SUPERNOVA', doomed, `A supernova wiped out ${label}.`))
  }
  if (owner) {
    messages.push(message(game, owner, nextTurn, 'LOSS', doomed,
      `${doomed.name} (#${doomed.number}) went up in a supernova. ` +
      `${lostShips} ships and ${lostResources} stockpiled resources are gone.`))
  }
  return doomed
}

/** IDs of the players who have ever seen this planet, the owner included. */
async function playersKnowing (planet, owner) {
  const { PlanetIntel } = cds.entities('galactic')
  const intel = await SELECT.from(PlanetIntel).columns('player_ID').where({ planet_ID: planet.ID })
  const known = new Set(intel.map(i => i.player_ID))
  if (owner) known.add(owner.ID)
  return known
}

/**
 * Re-targets fleets that lost their course, for either of two reasons:
 *
 *   - the star they were aiming at went up in a supernova, so they have to go
 *     somewhere else whether the rule is switched on or not
 *   - `diversionChance` rolled against them: an asteroid field bent the course
 *
 * Either way they are pushed onto one of the planets nearest to the target they
 * lost, and the detour costs at least one extra turn. The owner is told in the
 * same report, new target included: his ships are out of his hands, not out of
 * his sight.
 *
 * A fleet that lands this turn is already through: asteroid fields sit on the
 * route, not in the target system. Short hops are therefore always reliable.
 */
function resolveDiversions ({ game, fleets, planets, planetsById, playersById, rng, nextTurn, messages }) {
  const chance = Number(game.diversionChance) || 0

  for (const fleet of fleets) {
    const target = planetsById.get(fleet.destination_ID)
    if (!target) continue

    const lostTarget = !!target.destroyed
    const stillFlying = fleet.arrivalTurn > nextTurn
    // The roll only happens when the rule is on, so switching it off cannot
    // shift the RNG stream of a game that never uses it.
    if (!lostTarget && !(stillFlying && chance > 0 && rng() < chance)) continue

    const player = playersById.get(fleet.owner_ID)
    const detour = divertTarget({ target, planets, game, rng })

    // Nothing left in the galaxy to fall back on - the ships are stranded.
    if (!detour) {
      fleet.lost = true
      if (player) {
        messages.push(message(game, player, nextTurn, 'DIVERSION', target,
          `${fleet.ships} ships were lost with #${target.number} - there was nowhere left to divert them to.`))
      }
      continue
    }

    const arrivalTurn = divertedArrival({ fleet, detour: detour.detour, game, nextTurn })
    if (player) {
      const cause = lostTarget
        ? `The supernova at #${target.number} took the target of ${fleet.ships} ships.`
        : `An asteroid field threw ${fleet.ships} ships bound for #${target.number} off course.`
      messages.push(message(game, player, nextTurn, 'DIVERSION', detour.planet,
        `${cause} They now head for #${detour.planet.number}, arriving turn ${arrivalTurn}.`))
    }
    divert(fleet, detour, arrivalTurn)
  }
}

/** Puts a fleet on a new course. Distance grows, the ETA moves back. */
function divert (fleet, detour, arrivalTurn) {
  fleet.destination_ID = detour.planet.ID
  fleet.arrivalTurn = arrivalTurn
  fleet.distance = Math.round((Number(fleet.distance ?? 0) + detour.detour) * 100) / 100
  fleet.dirty = true
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
      production: planet.production,
      destroyed: !!planet.destroyed,
      x: planet.x,
      y: planet.y,
      vx: planet.vx,
      vy: planet.vy
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

/** Writes back the fleets a special rule pushed onto a new course. */
async function persistFleets (fleets) {
  const { Fleets } = cds.entities('galactic')
  for (const fleet of fleets.filter(f => f.dirty)) {
    await UPDATE(Fleets, fleet.ID).with({
      destination_ID: fleet.destination_ID,
      arrivalTurn: fleet.arrivalTurn,
      distance: fleet.distance
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
