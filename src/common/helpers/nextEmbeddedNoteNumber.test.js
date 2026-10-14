const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { nextEmbeddedNoteNumber } = require('./nextEmbeddedNoteNumber');

describe('nextEmbeddedNoteNumber', () => {
  it('starts at 1 for empty notes', () => {
    assert.equal(nextEmbeddedNoteNumber([]), 1);
    assert.equal(nextEmbeddedNoteNumber(undefined), 1);
  });

  it('increments from the highest existing noteNumber', () => {
    assert.equal(
      nextEmbeddedNoteNumber([{ noteNumber: 1 }, { noteNumber: 3 }, { noteNumber: 2 }]),
      4
    );
  });

  it('ignores invalid noteNumber values', () => {
    assert.equal(
      nextEmbeddedNoteNumber([{ noteNumber: null }, { noteNumber: 'x' }, {}]),
      1
    );
  });
});
