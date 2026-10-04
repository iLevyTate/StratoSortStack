// @ts-check
'use strict';
const { startMcpServer } = require('./server');

async function createMcpServer(/** @type {any} */ options) {
  return startMcpServer(options);
}

module.exports = { createMcpServer };
