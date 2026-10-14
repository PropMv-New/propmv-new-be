const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateBufferContent,
  isPlainTextBuffer,
  isJsonBuffer,
} = require('../common/helpers/fileContentValidation');
const {
  matchesProfileMetadata,
  createMulterFilter,
} = require('../common/helpers/fileValidationHelper');
const { getAcceptString, getProfile } = require('../common/constants/uploadFileTypes');

function mockFile(originalname, mimetype) {
  return { originalname, mimetype };
}

describe('uploadFileTypes profiles', () => {
  it('keeps image accept string aligned with frontend', () => {
    assert.equal(getAcceptString('IMAGE'), '.jpg,.jpeg,.png');
  });

  it('includes PDF and video types in maintenance profile', () => {
    const profile = getProfile('MAINTENANCE');
    assert.ok(profile.extensions.includes('.pdf'));
    assert.ok(profile.mimeTypes.includes('video/mp4'));
  });
});

describe('fileContentValidation', () => {
  it('accepts valid JPEG bytes', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const result = validateBufferContent(buffer, '.jpg', 'image/jpeg');
    assert.equal(result.valid, true);
  });

  it('rejects PDF extension with JPEG bytes', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const result = validateBufferContent(buffer, '.pdf', 'application/pdf');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'File content does not match its type');
  });

  it('accepts plain-text CSV buffers', () => {
    const buffer = Buffer.from('name,email\nJohn,john@example.com', 'utf8');
    assert.equal(isPlainTextBuffer(buffer), true);
    const result = validateBufferContent(buffer, '.csv', 'text/csv');
    assert.equal(result.valid, true);
  });

  it('accepts JSON buffers', () => {
    const buffer = Buffer.from('{"items":[]}', 'utf8');
    assert.equal(isJsonBuffer(buffer), true);
    const result = validateBufferContent(buffer, '.json', 'application/json');
    assert.equal(result.valid, true);
  });
});

describe('fileValidationHelper metadata filters', () => {
  it('accepts allowed image metadata', () => {
    assert.equal(matchesProfileMetadata(mockFile('photo.jpg', 'image/jpeg'), 'IMAGE'), true);
  });

  it('rejects disallowed extensions through multer filter', () => {
    const filter = createMulterFilter('PDF');
    let errorMessage;
    filter({}, mockFile('notes.txt', 'text/plain'), (err, allowed) => {
      if (err) errorMessage = err.message;
      assert.equal(allowed, undefined);
    });
    assert.match(errorMessage, /Only PDF files are allowed/);
  });

  it('accepts invoice document metadata', () => {
    assert.equal(
      matchesProfileMetadata(mockFile('receipt.pdf', 'application/pdf'), 'INVOICE_DOC'),
      true,
    );
  });
});
