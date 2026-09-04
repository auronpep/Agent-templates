#!/usr/bin/env node
'use strict';

/**
 * CommonJS interop guard.
 *
 * This package has no "type" field, so it is CommonJS and every dependency is
 * loaded with require(). Several dependencies here sit on their last CommonJS
 * major (chalk 4, inquirer 8, boxen 5, ora 5, open 8) because the next major is
 * ESM-only. Those ESM-only versions still INSTALL cleanly and still report a
 * healthy version number - they fail only when the code runs.
 *
 * Worse, they can pass on a maintainer's machine and fail in CI: Node >= 22.12
 * can require() an ESM package, while Node 18 and 20 throw ERR_REQUIRE_ESM.
 * This repo's workflows still test Node 18, 20 and 22, so the guard checks the
 * package metadata statically instead of trusting whichever Node runs it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

if (pkg.type === 'module') {
  console.log('package.json declares "type":"module"; CJS interop guard not applicable.');
  process.exit(0);
}

// Symbols this codebase actually calls, per package.
const REQUIRED = {
  chalk: ['red', 'green', 'yellow', 'blue', 'cyan', 'gray', 'dim', 'magenta', 'white'],
  inquirer: ['prompt', 'Separator', 'createPromptModule'],
  'fs-extra': ['readJson', 'writeJson', 'ensureDir', 'pathExists', 'copy', 'remove', 'existsSync'],
  uuid: ['v4'],
  'js-yaml': ['load', 'dump'],
  commander: ['program'],
};

const ENGINES = (pkg.engines && pkg.engines.node) || 'unpinned';

/**
 * A package can be "type":"module" and still be safe if its exports map carries
 * a "require" condition pointing at a CommonJS build - uuid 11 does exactly
 * that. Without one, require() only works via Node's require(ESM) support.
 */
function hasRequireCondition(node) {
  if (!node || typeof node !== 'object') return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'require') return true;
    if (hasRequireCondition(value)) return true;
  }
  return false;
}

const rows = [];
let failures = 0;

for (const name of Object.keys(pkg.dependencies || {})) {
  let version = null;
  let declaredType = 'commonjs';
  let esmOnly = false;

  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')
    );
    version = meta.version;
    declaredType = meta.type || 'commonjs';
    esmOnly = declaredType === 'module' && !hasRequireCondition(meta.exports);
  } catch (_) {
    // not installed, or package.json is not an exported subpath
  }

  if (esmOnly) {
    failures++;
    rows.push(['FAIL', name, version, declaredType,
      'ESM-only ("type":"module", no "require" export condition). Loads on ' +
      'Node >= 22.12 only; throws ERR_REQUIRE_ESM under engines ' + ENGINES + '.']);
    continue;
  }

  let mod = null;
  let loadError = null;
  try {
    mod = require(name);
  } catch (err) {
    loadError = err;
  }

  if (loadError) {
    failures++;
    rows.push(['FAIL', name, version, declaredType,
      loadError.code === 'ERR_REQUIRE_ESM'
        ? 'ERR_REQUIRE_ESM - cannot be require()d'
        : (loadError.code || String(loadError.message).split('\n')[0])]);
    continue;
  }

  const want = REQUIRED[name] || [];
  const missing = want.filter((k) => mod[k] === undefined);

  if (missing.length) {
    failures++;
    const shifted = mod.default ? want.filter((k) => mod.default[k] !== undefined) : [];
    rows.push(['FAIL', name, version, declaredType,
      'missing from require(): ' + missing.join(', ') +
      (shifted.length ? '  [present on .default - ESM/CJS interop shift]' : '')]);
    continue;
  }

  rows.push(['ok', name, version, declaredType,
    want.length ? want.length + ' symbols ok' : 'loads']);
}

const col = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n);
console.log(col('', 6) + col('package', 14) + col('version', 12) + col('type', 11) + 'result');
for (const r of rows) {
  console.log(col(r[0], 6) + col(r[1], 14) + col(r[2], 12) + col(r[3], 11) + r[4]);
}

if (failures) {
  console.error('\n' + failures + ' dependency(ies) not usable from CommonJS under engines ' + ENGINES + '.');
  console.error('Keep the dependency on its last CommonJS major, or migrate this package to ESM');
  console.error('and raise engines.node plus the CI matrix to >= 22.12.');
  process.exit(1);
}

console.log('\nAll ' + rows.length + ' dependencies load under require() with the expected API.');
