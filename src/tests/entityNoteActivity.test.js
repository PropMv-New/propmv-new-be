const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveActivityAction } = require('../common/services/entityNoteActivity.service');

describe('resolveActivityAction', () => {
  it('maps note lifecycle actions to Activity enum', () => {
    assert.equal(resolveActivityAction('created'), 'CREATE');
    assert.equal(resolveActivityAction('updated'), 'UPDATE');
    assert.equal(resolveActivityAction('deleted'), 'DELETE');
  });

  it('maps note flag/reminder actions to UPDATE', () => {
    assert.equal(resolveActivityAction('pinned'), 'UPDATE');
    assert.equal(resolveActivityAction('unpinned'), 'UPDATE');
    assert.equal(resolveActivityAction('important'), 'UPDATE');
    assert.equal(resolveActivityAction('reminder_set'), 'UPDATE');
    assert.equal(resolveActivityAction('reminder_completed'), 'UPDATE');
  });

  it('accepts legacy CREATED/DELETED aliases', () => {
    assert.equal(resolveActivityAction('CREATED'), 'CREATE');
    assert.equal(resolveActivityAction('DELETED'), 'DELETE');
  });

  it('defaults unknown actions to UPDATE', () => {
    assert.equal(resolveActivityAction('something_else'), 'UPDATE');
    assert.equal(resolveActivityAction(''), 'UPDATE');
  });
});
