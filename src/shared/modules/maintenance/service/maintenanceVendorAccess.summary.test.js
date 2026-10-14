'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('maintenance getById vendor community access', () => {
  it('skips active-hoa isolation for assigned vendor actors', () => {
    const src = fs.readFileSync(path.join(__dirname, 'maintenance.service.js'), 'utf8');
    const start = src.indexOf('async function getMaintenanceRequestById');
    assert.ok(start >= 0, 'getMaintenanceRequestById should exist');
    const nextFn = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
    assert.match(body, /vendorActor/);
    assert.match(body, /Assigned vendors may open tickets across/);
    assert.match(body, /else if \(options\.hoaContext\?\.hoaId\)/);
  });
});
