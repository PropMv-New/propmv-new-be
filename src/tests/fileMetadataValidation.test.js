const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFileMetadata } = require('../common/helpers/fileMetadataValidation');

test('rejects path traversal filenames', () => {
  const result = validateFileMetadata(
    { originalname: '../../etc/passwd.pdf', mimetype: 'application/pdf', size: 1024 },
    'PDF'
  );
  assert.equal(result.valid, false);
});

test('rejects executable double extensions', () => {
  const result = validateFileMetadata(
    { originalname: 'invoice.pdf.exe', mimetype: 'application/pdf', size: 1024 },
    'INVOICE_DOC'
  );
  assert.equal(result.valid, false);
});

test('rejects empty files when size is known', () => {
  const result = validateFileMetadata(
    { originalname: 'empty.pdf', mimetype: 'application/pdf', size: 0 },
    'PDF'
  );
  assert.equal(result.valid, false);
  assert.match(result.reason, /Empty files/);
});

test('rejects blocked script mime types', () => {
  const result = validateFileMetadata(
    { originalname: 'notes.txt', mimetype: 'application/javascript', size: 128 },
    'NOTE_ATTACHMENT'
  );
  assert.equal(result.valid, false);
});

test('accepts valid pdf metadata', () => {
  const result = validateFileMetadata(
    { originalname: 'statement.pdf', mimetype: 'application/pdf', size: 2048 },
    'PDF'
  );
  assert.equal(result.valid, true);
});
