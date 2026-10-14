const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  escapeRegex,
  buildMaintenanceSearchOrClauses,
} = require('./maintenanceListSearch.helper');

describe('maintenanceListSearch.helper', () => {
  it('escapes regex metacharacters so search does not match everything', () => {
    assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
    assert.equal(escapeRegex('(leak)'), '\\(leak\\)');
  });

  it('returns null for blank search text', async () => {
    assert.equal(await buildMaintenanceSearchOrClauses(''), null);
    assert.equal(await buildMaintenanceSearchOrClauses('   '), null);
  });

  it('always includes title, ticketNumber, description, and createdByName clauses', async () => {
    const clauses = await buildMaintenanceSearchOrClauses('roof');
    assert.ok(Array.isArray(clauses));
    assert.ok(clauses.some((c) => c.title && c.title.$regex === 'roof'));
    assert.ok(clauses.some((c) => c.ticketNumber && c.ticketNumber.$regex === 'roof'));
    assert.ok(clauses.some((c) => c.description && c.description.$regex === 'roof'));
    assert.ok(clauses.some((c) => c.createdByName && c.createdByName.$regex === 'roof'));
  });

  it('accepts hoa context without throwing', async () => {
    const hoaId = new mongoose.Types.ObjectId();
    const clauses = await buildMaintenanceSearchOrClauses('unit', {
      isHOABoardMember: true,
      hoaId,
    });
    assert.ok(Array.isArray(clauses));
    assert.ok(clauses.length >= 4);
  });
});
