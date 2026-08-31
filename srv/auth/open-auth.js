'use strict'

const cds = require('@sap/cds')

/**
 * Open authentication for the container deployment: there is no identity
 * provider, players simply type the name they want to play under.
 *
 * THIS IS NOT AUTHENTICATION. The username is whatever the client claims, so
 * anyone can play as anyone else. That is a deliberate choice for a LAN/hobby
 * setup - do not expose such an instance to the internet and do not use this
 * strategy where the identity has to mean anything.
 *
 * The name is read from the HTTP Basic header, which is what the web client
 * already sends, so the existing login screen keeps working unchanged.
 */
module.exports = function open_auth () {
  const gamemasters = new Set(
    (process.env.GE_GAMEMASTERS ?? '').split(',').map(name => name.trim()).filter(Boolean)
  )
  const log = cds.log('auth')
  log.warn('open authentication: every request is trusted with the name it sends')
  if (gamemasters.size) log.info('gamemasters:', [...gamemasters].join(', '))

  return function open_auth (req, res, next) {
    const id = usernameFrom(req)
    if (!id) {
      // No name yet: the client shows its login screen on 401.
      return res.set('WWW-Authenticate', 'Basic realm="Commander"').sendStatus(401)
    }

    const roles = gamemasters.has(id) ? ['player', 'gamemaster'] : ['player']
    const user = new cds.User({ id, roles })
    cds.context.user = req.user = user
    next()
  }
}

/**
 * `Authorization: Basic base64(name:)`. The password is ignored - there is
 * nothing to check it against.
 */
function usernameFrom (req) {
  const header = req.headers.authorization
  if (!header || !/^basic /i.test(header)) return null
  const decoded = Buffer.from(header.slice(6), 'base64').toString()
  const id = decoded.slice(0, decoded.indexOf(':') === -1 ? undefined : decoded.indexOf(':')).trim()
  return id || null
}
