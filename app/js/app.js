'use strict'

import { api, login, logout, user, useSessionAuth, isSessionAuth, detectSession, openEventStream, ApiError } from './api.js'
import { StarMap } from './starmap.js'

const $ = id => document.getElementById(id)

const MAP_WIDTH = 1600
const MAP_HEIGHT = 900

const state = {
  game: null,
  me: null,
  planets: [],
  fleets: [],
  reports: [],
  players: [],
  selection: { origin: null, target: null },
  hovered: null,
  closeStream: null,
  clock: null
}

let map = null

// --------------------------------------------------------------- screens

function show (screen) {
  for (const id of ['login', 'lobby', 'waitroom', 'game']) $(id).classList.toggle('hidden', id !== screen)
}

function toast (message, bad = false) {
  const node = $('toast')
  node.textContent = message
  node.classList.toggle('bad', bad)
  node.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.add('hidden'), 4000)
}

const errorText = err => {
  if (err instanceof ApiError && err.status === 403 && /lacking required roles/i.test(err.message)) {
    // The role collection is assigned but the scope is missing from the token:
    // scopes are baked in at login, so a role granted afterwards needs a new one.
    return isSessionAuth()
      ? 'Your session predates your role assignment. Log out and back in to refresh the token.'
      : err.message
  }
  return err instanceof ApiError ? err.message : String(err?.message ?? err)
}

// ----------------------------------------------------------------- login

$('login-btn').addEventListener('click', async () => {
  const name = $('login-user').value.trim()
  if (!name) return
  login(name)
  try {
    await openLobby()
  } catch (err) {
    logout()
    $('login-error').textContent = errorText(err)
  }
})

$('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') $('login-btn').click() })

$('logout-btn').addEventListener('click', () => {
  if (isSessionAuth()) {
    window.location.href = '/logout' // the approuter ends the session for us
    return
  }
  leaveGame()
  logout()
  show('login')
})

// ----------------------------------------------------------------- lobby

async function openLobby () {
  leaveGame()
  // Membership comes from MyPlayers - the display name may differ from the login.
  const [games, joined] = await Promise.all([api.openGames(), api.myGames()])
  $('lobby-user').textContent = user() ?? 'signed in'
  $('login-error').textContent = ''
  $('lobby-error').textContent = ''
  renderGameList(games, joined)
  show('lobby')
}

function renderGameList (games, joined) {
  const list = $('game-list')
  list.replaceChildren()
  if (!games.length) {
    const empty = document.createElement('li')
    empty.className = 'meta'
    empty.textContent = 'No open games - create one.'
    list.append(empty)
    return
  }

  for (const game of games) {
    const mine = joined.has(game.ID)
    const item = document.createElement('li')

    const info = document.createElement('div')
    info.innerHTML = `<b></b><div class="meta"></div>`
    info.querySelector('b').textContent = game.name
    info.querySelector('.meta').textContent =
      `${game.status.toLowerCase()} · ${game.players?.length ?? 0}/${game.maxPlayers} players · ${game.planetCount} planets` +
      (game.status === 'RUNNING' ? ` · turn ${game.currentTurn}` : '')

    const button = document.createElement('button')
    button.textContent = mine ? 'Resume' : (game.status === 'LOBBY' ? 'Join' : 'Running')
    button.disabled = !mine && game.status !== 'LOBBY'
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        if (!mine) await api.joinGame(game.ID, user() ?? undefined)
        await enterGame(game.ID)
      } catch (err) {
        $('lobby-error').textContent = errorText(err)
        button.disabled = false
      }
    })

    item.append(info, button)
    list.append(item)
  }
}

$('create-btn').addEventListener('click', async () => {
  $('lobby-error').textContent = ''
  try {
    const id = await api.createGame({
      name: $('new-name').value.trim() || 'Skirmish',
      planetCount: Number($('new-planets').value),
      maxPlayers: Number($('new-players').value),
      turnLimitSec: Number($('new-limit').value),
      shipSpeed: Number($('new-speed').value),
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT
    })
    await enterGame(id)
  } catch (err) {
    $('lobby-error').textContent = errorText(err)
  }
})

// ------------------------------------------------------------- wait room

async function enterGame (gameId) {
  state.game = await api.game(gameId)
  state.me = await api.me(gameId)
  state.selection = { origin: null, target: null }
  document.body.dataset.game = gameId

  state.closeStream?.()
  state.closeStream = openEventStream(gameId, streamHandlers)

  if (state.game.status === 'LOBBY') await showWaitRoom()
  else await showGame()
}

function leaveGame () {
  state.closeStream?.()
  state.closeStream = null
  clearInterval(state.clock)
  state.clock = null
  state.game = null
}

async function showWaitRoom () {
  state.players = await api.participants(state.game.ID)
  $('wait-name').textContent = state.game.name
  $('wait-error').textContent = ''
  renderPlayers($('wait-players'))
  show('waitroom')
}

$('start-btn').addEventListener('click', async () => {
  try {
    await api.startGame(state.game.ID)
  } catch (err) {
    $('wait-error').textContent = errorText(err)
  }
})

$('wait-back').addEventListener('click', () => openLobby())
$('leave-btn').addEventListener('click', () => openLobby())

// ------------------------------------------------------------ game view

async function showGame () {
  map ??= new StarMap($('starmap'), {
    onClick: onPlanetClick,
    onEnter: showTooltip,
    onMove: moveTooltip,
    onLeave: hideTooltip
  })
  map.configure(state.game)
  show('game')
  $('game-name').textContent = state.game.name
  await refresh()
  startClock()
}

async function refresh () {
  const [game, me, planets, fleets, reports, players] = await Promise.all([
    api.game(state.game.ID),
    api.me(state.game.ID),
    api.starMap(state.game.ID),
    api.fleets(state.game.ID),
    api.reports(state.game.ID),
    api.participants(state.game.ID)
  ])
  Object.assign(state, { game, me, planets, fleets, reports, players })
  render()
}

function render () {
  drawMap()
  renderStats()
  renderPlayers($('player-list'))
  renderReports()
  renderOrderPanel()

  $('turn-no').textContent = state.game.status === 'FINISHED'
    ? 'game over'
    : `turn ${state.game.currentTurn}`
  $('endturn-btn').disabled = state.me.turnDone || state.me.eliminated || state.game.status !== 'RUNNING'
  $('endturn-btn').textContent = state.me.turnDone ? 'Waiting for others' : 'End turn'

  if (state.game.status === 'FINISHED') {
    $('waiting').textContent = state.game.winnerName ? `${state.game.winnerName} won` : 'game over'
  }
}

/** Full redraw - only after the data changed. */
function drawMap () {
  map.draw({
    planets: state.planets,
    fleets: state.fleets.map(f => ({ ...f, color: state.me.color })),
    currentTurn: state.game.currentTurn,
    selection: state.selection,
    preview: currentPreview()
  })
}

function currentPreview () {
  const byNumber = new Map(state.planets.map(p => [p.number, p]))
  const origin = byNumber.get(state.selection.origin)
  const targetNumber = state.selection.target ?? (state.hovered !== state.selection.origin ? state.hovered : null)
  const target = byNumber.get(targetNumber)
  return origin && target ? { from: origin, to: target } : null
}

/** Selection ring + preview line without rebuilding the map. */
function updateSelectionVisuals () {
  map.setSelection(state.selection)
  map.setPreview(currentPreview())
}

function renderStats () {
  const mine = state.planets.filter(p => p.mine)
  $('stat-resources').textContent = state.me.resources
  $('stat-planets').textContent = mine.length
  $('stat-ships').textContent = mine.reduce((sum, p) => sum + (p.ships ?? 0), 0)
  $('stat-transit').textContent = state.fleets.reduce((sum, f) => sum + f.ships, 0)
}

function renderPlayers (target) {
  target.replaceChildren()
  for (const player of state.players) {
    const item = document.createElement('li')
    if (player.eliminated) item.classList.add('dead')

    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.background = player.color

    const name = document.createElement('span')
    name.textContent = player.name + (player.name === state.me?.name ? ' (you)' : '')

    const flag = document.createElement('span')
    flag.className = 'flag' + (player.turnDone ? ' ready' : '')
    flag.textContent = player.eliminated ? 'eliminated' : (player.turnDone ? 'ready' : '')

    item.append(dot, name, flag)
    target.append(item)
  }
}

function renderReports () {
  const list = $('report-list')
  list.replaceChildren()
  for (const report of state.reports) {
    const item = document.createElement('li')
    item.className = report.kind
    const tag = document.createElement('div')
    tag.className = 'turn-tag'
    tag.textContent = `turn ${report.turn}`
    const text = document.createElement('div')
    text.textContent = report.text
    item.append(tag, text)
    list.append(item)
  }
}

// -------------------------------------------------------------- orders

function onPlanetClick (planet) {
  if (state.game.status !== 'RUNNING' || state.me.turnDone) return

  if (state.selection.origin === planet.number) {
    clearSelection()
    return
  }
  if (state.selection.origin === null) {
    if (!planet.mine) return toast('You can only send ships from your own planets.')
    state.selection = { origin: planet.number, target: null }
  } else {
    state.selection.target = planet.number
  }
  renderOrderPanel()
  updateSelectionVisuals()
}

function clearSelection () {
  state.selection = { origin: null, target: null }
  renderOrderPanel()
  updateSelectionVisuals()
}

$('clear-btn').addEventListener('click', clearSelection)

// Only a click on empty space clears - never one that landed on a planet.
$('starmap').addEventListener('click', event => {
  if (event.target === $('starmap')) clearSelection()
})

async function renderOrderPanel () {
  const byNumber = new Map(state.planets.map(p => [p.number, p]))
  const origin = byNumber.get(state.selection.origin)
  const target = byNumber.get(state.selection.target)

  $('build-box').classList.toggle('hidden', !origin)
  $('send-box').classList.toggle('hidden', !origin || !target)
  $('order-hint').classList.toggle('hidden', !!origin && !!target)
  $('order-hint').textContent = origin
    ? 'Pick a destination on the map.'
    : 'Select one of your planets.'

  if (!origin) return

  $('build-dot').style.background = origin.color
  $('build-name').textContent = `#${origin.number} ${origin.name} - ${origin.ships} ships`
  $('build-cost').textContent =
    `${state.game.shipCost} resources per ship, you have ${state.me.resources}` +
    (origin.pendingShips ? ` · ${origin.pendingShips} arriving next turn` : '')
  $('build-count').max = Math.floor(state.me.resources / state.game.shipCost)

  if (!target) return

  $('from-dot').style.background = origin.color
  $('from-name').textContent = `#${origin.number}`
  $('to-dot').style.background = target.color
  $('to-name').textContent = target.explored ? `#${target.number} ${target.name}` : `#${target.number}`
  $('send-count').max = origin.ships
  // Never leave the field on a value the planet cannot supply.
  $('send-count').value = Math.max(1, Math.min(Number($('send-count').value) || 1, origin.ships))

  try {
    const route = await api.route(state.game.ID, origin.number, target.number)
    $('route-info').textContent =
      `${Math.round(route.distance)} units · ${route.turns} turn${route.turns === 1 ? '' : 's'}` +
      ` · arrives turn ${state.game.currentTurn + route.turns}`
  } catch {
    $('route-info').textContent = ''
  }
}

$('build-btn').addEventListener('click', async () => {
  const count = Number($('build-count').value)
  try {
    await api.buildShips(state.game.ID, state.selection.origin, count)
    await refresh()
    toast(`${count} ships ordered.`)
  } catch (err) {
    toast(errorText(err), true)
  }
})

$('send-btn').addEventListener('click', async () => {
  const { origin, target } = state.selection
  const ships = Number($('send-count').value)
  try {
    const fleet = await api.sendFleet(state.game.ID, origin, target, ships)
    clearSelection()
    await refresh()
    toast(`${ships} ships on their way, arriving turn ${fleet.arrivalTurn}.`)
  } catch (err) {
    toast(errorText(err), true)
  }
})

$('endturn-btn').addEventListener('click', async () => {
  $('endturn-btn').disabled = true
  try {
    const result = await api.endTurn(state.game.ID)
    if (!result.resolved) $('waiting').textContent = `waiting for ${result.waitingFor} player(s)`
    await refresh()
  } catch (err) {
    toast(errorText(err), true)
    render()
  }
})

// ------------------------------------------------------------- tooltip

function showTooltip (planet, event) {
  state.hovered = planet.number
  const tip = $('tooltip')
  const rows = []

  if (planet.explored) {
    if (planet.ownerName) rows.push(['owner', planet.ownerName])
    rows.push(['production', `${planet.production}/turn`])
    if (planet.natives > 0) rows.push(['natives', planet.natives])
    else rows.push(['ships', planet.ships ?? 0])
    if (planet.pendingShips) rows.push(['building', planet.pendingShips])
  }

  tip.replaceChildren()
  const head = document.createElement('div')
  head.className = 'tt-head'
  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.style.background = planet.color
  const title = document.createElement('span')
  title.textContent = planet.explored ? planet.name : 'unexplored'
  const num = document.createElement('span')
  num.className = 'tt-num'
  num.textContent = `#${planet.number}`
  head.append(dot, title, num)
  tip.append(head)

  if (rows.length) {
    const dl = document.createElement('dl')
    for (const [key, value] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = key
      const dd = document.createElement('dd')
      dd.textContent = value
      dl.append(dt, dd)
    }
    tip.append(dl)
  }

  // Intel ages: what you saw three turns ago may not be true any more.
  if (planet.explored && !planet.mine && planet.lastSeenTurn < state.game.currentTurn) {
    const stale = document.createElement('p')
    stale.className = 'stale'
    stale.textContent = `last seen turn ${planet.lastSeenTurn}`
    tip.append(stale)
  }

  tip.classList.remove('hidden')
  moveTooltip(planet, event)
  if (state.selection.origin !== null && !state.selection.target) map.setPreview(currentPreview())
}

function moveTooltip (planet, event) {
  const tip = $('tooltip')
  const pane = $('map-pane').getBoundingClientRect()
  const x = event.clientX - pane.left
  const y = event.clientY - pane.top
  const flipX = x + tip.offsetWidth + 24 > pane.width
  const flipY = y + tip.offsetHeight + 24 > pane.height
  tip.style.left = `${flipX ? x - tip.offsetWidth - 16 : x + 16}px`
  tip.style.top = `${flipY ? y - tip.offsetHeight - 16 : y + 16}px`
}

function hideTooltip () {
  state.hovered = null
  $('tooltip').classList.add('hidden')
  if (state.selection.origin !== null && !state.selection.target) map.setPreview(currentPreview())
}

// --------------------------------------------------------------- clock

function startClock () {
  clearInterval(state.clock)
  state.clock = setInterval(() => {
    if (!state.game?.turnDeadline || state.game.status !== 'RUNNING') {
      $('countdown').textContent = '--:--'
      return
    }
    const left = Math.max(0, new Date(state.game.turnDeadline) - Date.now())
    const minutes = Math.floor(left / 60000)
    const seconds = Math.floor(left / 1000) % 60
    $('countdown').textContent = `${minutes}:${String(seconds).padStart(2, '0')}`
  }, 1000)
}

// -------------------------------------------------------- live updates

const streamHandlers = {
  playerJoined: async data => {
    if (state.game?.status !== 'LOBBY') return
    await showWaitRoom()
    toast(`${data.name} joined.`)
  },

  gameStarted: async () => {
    state.game = await api.game(state.game.ID)
    state.me = await api.me(state.game.ID)
    await showGame()
    toast('The game has started.')
  },

  playerReady: data => {
    const player = state.players.find(p => p.name === data.name)
    if (player) player.turnDone = true
    renderPlayers($('player-list'))
    $('waiting').textContent = `waiting for ${data.waitingFor} player(s)`
  },

  turnResolved: async data => {
    $('waiting').textContent = ''
    await refresh()
    toast(data.finished
      ? (data.winner ? `${data.winner} won the game.` : 'Game over.')
      : `Turn ${data.turn} begins.`)
  },

  report: data => {
    // Prepended right away; `refresh` re-reads them from the server anyway.
    state.reports = [...data.messages.map(m => ({ ...m, turn: data.turn })), ...state.reports]
    renderReports()
  },

  error: err => toast(`connection lost: ${errorText(err)} - retrying`, true)
}

/**
 * Behind the approuter the user is already authenticated, so the dev login
 * screen is skipped. Locally `/user-api/currentUser` does not exist and we
 * fall back to picking a mocked user.
 */
async function boot () {
  const session = await detectSession()
  if (!session) return show('login')

  useSessionAuth(session.name) // may be null - the server knows who we are anyway
  $('logout-btn').textContent = 'log out'
  try {
    await openLobby()
  } catch (err) {
    show('login')
    $('login-error').textContent = errorText(err)
    if (err instanceof ApiError && err.status === 403) {
      $('login-btn').textContent = 'Log out and sign in again'
      $('login-btn').onclick = () => { window.location.href = '/logout' }
    }
  }
}

boot()
