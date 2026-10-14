const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOA_DOCUMENT_MAX_TOTAL_BYTES,
  getTotalFileSizeBytes,
  assertHoaDocumentUploadSize,
} = require('../helpers/hoaDocumentUploadLimits');

test('getTotalFileSizeBytes sums file sizes', () => {
  assert.equal(
    getTotalFileSizeBytes([{ size: 1024 }, { size: 2048 }]),
    3072,
  );
});

test('assertHoaDocumentUploadSize allows files within total limit', () => {
  assert.doesNotThrow(() =>
    assertHoaDocumentUploadSize([
      { size: 5 * 1024 * 1024, originalname: 'a.pdf' },
      { size: 10 * 1024 * 1024, originalname: 'b.pdf' },
    ]),
  );
});

test('assertHoaDocumentUploadSize rejects total size above 20MB', () => {
  assert.throws(
    () =>
      assertHoaDocumentUploadSize([
        { size: 12 * 1024 * 1024, originalname: 'a.pdf' },
        { size: 10 * 1024 * 1024, originalname: 'b.pdf' },
      ]),
    (err) => err.status === 400 && /Total document size exceeds/.test(err.message),
  );
});

test('assertHoaDocumentUploadSize rejects single file above per-file limit', () => {
  assert.throws(
    () =>
      assertHoaDocumentUploadSize([
        { size: HOA_DOCUMENT_MAX_TOTAL_BYTES + 1, originalname: 'large.pdf' },
      ]),
    (err) => err.status === 400 && /exceeds the 20MB file size limit/.test(err.message),
  );
});
