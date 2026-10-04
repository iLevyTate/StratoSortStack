#!/usr/bin/env node
const { mergeIntoCombined } = require('./build-win-dual.js');
mergeIntoCombined();
console.log('Merged dual-windows artifacts into release/dual-windows/combined');
