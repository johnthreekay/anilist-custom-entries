// Tiny extraction harness: pulls named functions / marked blocks out of the
// userscript source and evaluates them with stubbed dependencies, so the
// pure logic can be exercised in Node without a browser.
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'anilist-custom-entries.user.js'), 'utf8');

// Source of `  function NAME(` (top-level, two-space indent). Top-level
// functions in the script end with a line that is exactly "  }", which is
// safer than brace counting (strings and regexes contain braces).
function grabFunction(name) {
  let i = SRC.indexOf(`  function ${name}(`);
  if (i < 0) i = SRC.indexOf(`  async function ${name}(`);
  if (i < 0) throw new Error('function not found: ' + name);
  const j = SRC.indexOf('\n  }\n', i);
  if (j < 0) throw new Error('function end not found: ' + name);
  return SRC.slice(i, j + 4);
}
// Source of `  const NAME = ...;` up to the first `;\n` (single-statement consts).
function grabConst(name) {
  const i = SRC.indexOf(`  const ${name} = `);
  if (i < 0) throw new Error('const not found: ' + name);
  const j = SRC.indexOf(';\n', i);
  return SRC.slice(i, j + 1);
}
// Source between a start marker and the end of the function whose header
// follows `endFnName` ("  function endFnName(" ... closing brace).
function grabBetween(startMarker, endFnName) {
  const start = SRC.indexOf(startMarker);
  if (start < 0) throw new Error('marker not found: ' + startMarker);
  const fnStart = SRC.indexOf(`  function ${endFnName}(`, start);
  if (fnStart < 0) throw new Error('end function not found: ' + endFnName);
  const fnSrc = grabFunction(endFnName);
  return SRC.slice(start, fnStart) + fnSrc;
}
// Evaluate a code block with named dependencies; returns the object built
// from `returns` (array of identifier names defined in the block).
function evalBlock(code, deps, returns) {
  const names = Object.keys(deps);
  const body = code + '\nreturn { ' + returns.join(', ') + ' };';
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map((n) => deps[n]));
}

const ID_BASE = 2000000000;
const isCustomId = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= ID_BASE; };

function makeExpect(label) {
  let fail = 0;
  let pass = 0;
  const expect = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' → ' + JSON.stringify(got) + ' (want ' + JSON.stringify(want) + ')'}`);
  };
  const done = () => ({ label, pass, fail });
  return { expect, done };
}

module.exports = { SRC, grabFunction, grabConst, grabBetween, evalBlock, ID_BASE, isCustomId, makeExpect };
