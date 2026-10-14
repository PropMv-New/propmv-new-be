'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  assertCheck21ImageFile,
  bufferToDataUri,
  buildCheck21MultipartForm,
  buildCheck21TransactionBody,
  buildCheck21OrderNumber,
  toCheck21UserFriendlyMessage,
  CHECK21_MAX_BYTES,
} = require('./payloadCheck21.util');
const { toUserFriendlyPayloadMessage } = require('./payloadUserError.util');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF_MAGIC = Buffer.from('%PDF-1.4 mock');

describe('payloadCheck21.util', () => {
  it('rejects missing or empty files', () => {
    assert.throws(() => assertCheck21ImageFile(null, 'Check front'), /required/i);
    assert.throws(
      () => assertCheck21ImageFile({ buffer: Buffer.alloc(0), mimetype: 'image/png' }, 'Check front'),
      /required/i,
    );
  });

  it('rejects unsupported mime types, bad magic bytes, and oversized files', () => {
    assert.throws(
      () => assertCheck21ImageFile({
        buffer: Buffer.from('abc'),
        mimetype: 'text/plain',
        originalname: 'x.txt',
      }, 'Check front'),
      /JPG, PNG, or PDF/i,
    );
    assert.throws(
      () => assertCheck21ImageFile({
        buffer: Buffer.from('not-a-png'),
        mimetype: 'image/png',
        originalname: 'fake.png',
      }, 'Check front'),
      /content does not match/i,
    );
    assert.throws(
      () => assertCheck21ImageFile({
        buffer: Buffer.alloc(CHECK21_MAX_BYTES + 1),
        mimetype: 'image/png',
        originalname: 'big.png',
      }, 'Check front'),
      /10MB/i,
    );
  });

  it('accepts jpg/png/pdf with valid magic bytes and builds data URIs', () => {
    const png = assertCheck21ImageFile({
      buffer: PNG_MAGIC,
      mimetype: 'image/png',
      originalname: 'front.png',
    }, 'Check front');
    assert.equal(png.mimeType, 'image/png');
    const uri = bufferToDataUri(png.buffer, png.mimeType);
    assert.match(uri, /^data:image\/png;base64,/);

    const jpeg = assertCheck21ImageFile({
      buffer: JPEG_MAGIC,
      mimetype: 'image/jpeg',
      originalname: 'back.jpg',
    }, 'Check back');
    assert.equal(jpeg.mimeType, 'image/jpeg');

    const pdf = assertCheck21ImageFile({
      buffer: PDF_MAGIC,
      mimetype: 'application/pdf',
      originalname: 'front.pdf',
    }, 'Check front');
    assert.equal(pdf.mimeType, 'application/pdf');
  });

  it('builds multipart Check21 form with processing_id + check_front/check_back + order_number', () => {
    const frontBuf = Buffer.concat([JPEG_MAGIC, Buffer.from('FRONT')]);
    const backBuf = Buffer.concat([PNG_MAGIC, Buffer.from('BACK')]);
    const { form, meta } = buildCheck21MultipartForm({
      processingAccountId: 'acct_processing123',
      frontFile: { buffer: frontBuf, mimetype: 'image/jpeg', originalname: 'front.jpg' },
      backFile: { buffer: backBuf, mimetype: 'image/png', originalname: 'back.png' },
      amount: 250,
      description: 'Invoice check',
      orderNumber: 'c21_abc_12345678',
    });

    assert.equal(typeof form.getHeaders, 'function');
    assert.equal(meta.type, 'payment');
    assert.equal(meta.source, 'check');
    assert.equal(meta.processing_id, 'acct_processing123');
    assert.equal(meta.amount, 250);
    assert.equal(meta.description, 'Invoice check');
    assert.equal(meta.order_number, 'c21_abc_12345678');
    assert.equal(meta.check_front.bytes, frontBuf.length);
    assert.equal(meta.check_back.bytes, backBuf.length);
    assert.equal(meta.localAttrs.propmv_check21, '1');
    assert.equal(meta.receiver, undefined);
    assert.equal(meta.check_images, undefined);
  });

  it('builds order_number distinct from idempotency style hashes', () => {
    const order = buildCheck21OrderNumber('507f1f77bcf86cd799439011', 'attempt-1');
    assert.match(order, /^c21_/);
    assert.ok(order.length <= 64);
  });

  it('rejects identical front/back buffers and invalid account/amount', () => {
    const same = Buffer.concat([PNG_MAGIC, Buffer.from('SAME')]);
    assert.throws(
      () => buildCheck21MultipartForm({
        processingAccountId: 'acct_ok',
        frontFile: { buffer: same, mimetype: 'image/png', originalname: 'a.png' },
        backFile: { buffer: Buffer.from(same), mimetype: 'image/png', originalname: 'b.png' },
      }),
      /different/i,
    );
    assert.throws(
      () => buildCheck21MultipartForm({
        processingAccountId: 'hoa:not-an-acct',
        frontFile: { buffer: Buffer.concat([PNG_MAGIC, Buffer.from('A')]), mimetype: 'image/png', originalname: 'a.png' },
        backFile: { buffer: Buffer.concat([PNG_MAGIC, Buffer.from('B')]), mimetype: 'image/png', originalname: 'b.png' },
      }),
      /processing account/i,
    );
    assert.throws(
      () => buildCheck21TransactionBody({
        processingAccountId: 'acct_ok',
        frontDataUri: 'data:image/png;base64,AA',
        backDataUri: 'data:image/png;base64,BB',
        amount: -1,
      }),
      /positive/i,
    );
  });

  it('maps Check21 Payload errors without Card/ACH saved-method copy', () => {
    const generic = toUserFriendlyPayloadMessage(400, 'check_images, receiver');
    assert.doesNotMatch(generic, /saved payment method/i);

    const check21 = toCheck21UserFriendlyMessage(
      400,
      'check_images, receiver',
      { details: { check_front: { file: 'Invalid or unreadable check image' } } },
    );
    assert.match(check21, /check images|Check21|read the check/i);
    assert.doesNotMatch(check21, /saved payment method/i);
  });

  it('production Check21 payin service uses multipart client and invoice processing helpers', () => {
    const servicePath = path.join(__dirname, '../service/payloadCheck21Payin.service.js');
    const src = fs.readFileSync(servicePath, 'utf8');
    assert.match(src, /createCheck21PaymentTransaction/);
    assert.match(src, /buildCheck21MultipartForm/);
    assert.match(src, /ensureGatewayProcessingPaymentRecorded|PayloadPayin/);
    assert.doesNotMatch(src, /payloadCheck21Demo/);
  });
});
