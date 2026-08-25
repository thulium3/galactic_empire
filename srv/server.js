'use strict'

const cds = require('@sap/cds')
const mountEventStream = require('./sse')

cds.on('bootstrap', app => mountEventStream(app))

module.exports = cds.server
