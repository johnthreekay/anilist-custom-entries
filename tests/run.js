#!/usr/bin/env node
// Runs every tests/*.test.js (each exports an async or sync function
// returning {label, pass, fail}); exits 1 if anything failed.
'use strict';
const fs = require('fs');
const path = require('path');

(async () => {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  let pass = 0;
  let fail = 0;
  for (const f of files) {
    console.log(`\n${f}`);
    const r = await require(path.join(__dirname, f))();
    pass += r.pass;
    fail += r.fail;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
