'use strict'

const cds = require('@sap/cds')
const { subscribe } = require('./lib/event-bus')

const HEARTBEAT_MS = 25000
const RETRY_MS = 3000

/**
 * Live turn reports over Server-Sent Events.
 *
 *   GET /events?game=<uuid>
 *
 * Server to client only - every player action still goes through the OData API.
 * The browser's EventSource reconnects on its own, and `MyMessages` stays the
 * fallback for clients that miss events while disconnected.
 */
module.exports = function mountEventStream (app) {
  app.get('/events', ...authChain(), async (req, res) => {
    const gameId = req.query.game
    const user = req.user?.id ?? cds.context?.user?.id

    if (!gameId) return res.status(400).json({ error: 'query parameter "game" is required' })
    if (!user) return res.status(401).json({ error: 'not authenticated' })

    const player = await cds.tx(async () => {
      const { Players } = cds.entities('galactic')
      return SELECT.one.from(Players).where({ game_ID: gameId, user })
    })
    if (!player) return res.status(403).json({ error: 'you are not part of this game' })

    openStream({ req, res, gameId, user, player })
  })
}

function openStream ({ req, res, gameId, user, player }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // do not let a reverse proxy buffer the stream
  })
  res.write(`retry: ${RETRY_MS}\n\n`)

  const send = (name, data) => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    res.flush?.()
  }

  const unsubscribe = subscribe(gameId, user, send)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  heartbeat.unref?.()

  send('connected', { game: gameId, player: player.ID, name: player.name, color: player.color })
  cds.log('galactic').info(`event stream opened for ${user} on game ${gameId}`)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    cds.log('galactic').info(`event stream closed for ${user} on game ${gameId}`)
  })
}

/** Reuses the CAP request context and auth middlewares for this custom route. */
function authChain () {
  return cds.middlewares.before
    .map(entry => (typeof entry === 'function' ? entry : entry.factory?.()))
    .filter(mw => typeof mw === 'function')
}
