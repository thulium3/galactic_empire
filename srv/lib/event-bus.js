'use strict'

const cds = require('@sap/cds')

/**
 * In-process pub/sub for live game events.
 *
 * Subscribers are grouped per game; an event either goes to every subscriber of
 * that game or, when `to` is set, only to the connections of that single user.
 *
 * Single instance only. For a scaled out deployment replace `dispatch` with a
 * Redis pub/sub fan-out - that is the only seam that needs to change.
 */
const subscribers = new Map() // gameId -> Set<{ user, send }>

function subscribe (gameId, user, send) {
  if (!subscribers.has(gameId)) subscribers.set(gameId, new Set())
  const entry = { user, send }
  subscribers.get(gameId).add(entry)

  return function unsubscribe () {
    const group = subscribers.get(gameId)
    if (!group) return
    group.delete(entry)
    if (group.size === 0) subscribers.delete(gameId)
  }
}

/** Delivers immediately - use `publish` unless you are outside a transaction. */
function dispatch (gameId, event) {
  const group = subscribers.get(gameId)
  if (!group) return 0
  let delivered = 0
  for (const entry of group) {
    if (event.to && entry.user !== event.to) continue
    try {
      entry.send(event.name, event.data)
      delivered++
    } catch (err) {
      cds.log('galactic').warn('failed to push event:', err.message)
    }
  }
  return delivered
}

/**
 * Queues an event until the current transaction commits, so clients never see
 * state that a rollback would take back. Falls back to immediate delivery when
 * called outside a transaction.
 */
function publish (gameId, name, data, to = null) {
  const event = { name, data, to }
  const context = cds.context
  if (!context) return dispatch(gameId, event)

  if (!context._galacticEvents) {
    context._galacticEvents = []
    context.on('succeeded', () => {
      for (const queued of context._galacticEvents) dispatch(queued.gameId, queued.event)
    })
  }
  context._galacticEvents.push({ gameId, event })
}

/** Number of open connections, per game or in total. Used by tests and health checks. */
function connectionCount (gameId) {
  if (gameId) return subscribers.get(gameId)?.size ?? 0
  return [...subscribers.values()].reduce((sum, group) => sum + group.size, 0)
}

module.exports = { subscribe, publish, dispatch, connectionCount }
