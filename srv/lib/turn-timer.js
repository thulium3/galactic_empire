'use strict'

const cds = require('@sap/cds')
const { resolveTurn } = require('./turn-engine')

const DEFAULT_INTERVAL_MS = 5000
let timer = null

/**
 * Enforces the per turn time limit: any running game whose deadline has passed
 * is resolved with whatever the players submitted so far.
 * Disable with GE_DISABLE_TURN_TIMER=true (tests, batch scenarios).
 */
function startTurnTimer (intervalMs = Number(process.env.GE_TURN_TICK_MS) || DEFAULT_INTERVAL_MS) {
  if (timer || process.env.GE_DISABLE_TURN_TIMER === 'true') return timer
  timer = setInterval(() => {
    tick().catch(err => cds.log('galactic').error('turn timer failed:', err))
  }, intervalMs)
  timer.unref?.()
  cds.on('shutdown', stopTurnTimer)
  return timer
}

function stopTurnTimer () {
  if (timer) clearInterval(timer)
  timer = null
}

/** Resolves every game whose turn deadline has expired, each in its own transaction. */
async function tick () {
  const { Games } = cds.entities('galactic')
  const now = new Date().toISOString()
  const due = await cds.tx(() => SELECT.from(Games).where({ status: 'RUNNING' }).and('turnDeadline <', now))

  for (const game of due) {
    try {
      await cds.tx(() => resolveTurn(game))
      cds.log('galactic').info(`turn ${game.currentTurn + 1} auto-resolved for game ${game.name}`)
    } catch (err) {
      cds.log('galactic').error(`auto-resolve failed for game ${game.ID}:`, err)
    }
  }
}

module.exports = { startTurnTimer, stopTurnTimer, tick }
