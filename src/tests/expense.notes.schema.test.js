/**
 * Unit tests: Joi schema for POST /expense/:id/notes (no database).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { addNoteSchema } = require('../shared/modules/expense/validators/expense.validator');

describe('addNoteSchema', () => {
  test('accepts { text: "hello" }', () => {
    const { error, value } = addNoteSchema.validate({ text: 'hello' });
    assert.equal(error, undefined);
    assert.equal(value.text, 'hello');
  });

  test('accepts { content: "hello" } (alias for clients)', () => {
    const { error, value } = addNoteSchema.validate({ content: 'hello' });
    assert.equal(error, undefined);
    assert.equal(value.content, 'hello');
  });

  test('rejects when neither text nor content is set', () => {
    const { error } = addNoteSchema.validate({});
    assert.ok(error, 'expected validation error');
  });

  test('rejects empty string after trim', () => {
    const { error } = addNoteSchema.validate({ text: '   ' });
    assert.ok(error, 'expected validation error for whitespace');
  });

  test('keeps extra keys with unknown(true) for forward compatibility', () => {
    const { error, value } = addNoteSchema.validate({
      text: 'note',
      createdBy: 'x',
      landlord_id: 'y'
    });
    assert.equal(error, undefined);
    assert.equal(value.text, 'note');
  });
});
