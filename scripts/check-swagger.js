/**
 * ------------------------------------------------------------------
 * File: check-swagger.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// scripts/check-swagger.js
// Simple script to fetch generated swagger JSON and verify module grouping and presence of paths.
// Usage: node scripts/check-swagger.js

const fs = require('fs');
const path = require('path');
const url = process.env.SWAGGER_URL || 'http://localhost:5000/api/docs/swagger.json';

async function main() {
  try {
    const modulesDir = path.join(__dirname, '..', 'src', 'modules');
    const moduleNames = fs.existsSync(modulesDir)
      ? fs.readdirSync(modulesDir).filter((f) => fs.statSync(path.join(modulesDir, f)).isDirectory())
      : [];

    console.log('Expected modules:', moduleNames.join(', ') || '(none)');
    console.log('Fetching', url);

    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch swagger JSON: ' + res.status + ' ' + res.statusText);
    const spec = await res.json();

    const tags = (spec.tags || []).map((t) => t.name.toLowerCase());
    console.log('Found tags:', tags.join(', '));

    const missing = moduleNames.filter((m) => !tags.includes(m.toLowerCase()));
    if (missing.length) {
      console.log('Missing module tags in spec:', missing.join(', '));
    } else {
      console.log('All modules found as tags in swagger spec.');
    }

    // quick path check for a few modules
    moduleNames.slice(0, 10).forEach((m) => {
      const anyPath = Object.keys(spec.paths || {}).some((p) => p.toLowerCase().includes('/' + m.toLowerCase()));
      console.log(`Module ${m}: paths present? ${anyPath}`);
    });

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(2);
  }
}

main();
