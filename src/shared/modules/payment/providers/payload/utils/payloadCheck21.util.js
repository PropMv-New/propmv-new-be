'use strict';

/**
 * Check21 (remote deposit) helpers — production + shared validation.
 *
 * Live Payload Transaction.create accepts multipart:
 *   type=payment, source=check, processing_id=acct_…,
 *   check_front[file], check_back[file], optional amount / order_number / description
 * Docs JSON (receiver / check_images) is rejected as InvalidAttributes on live API.
 */

const crypto = require('crypto');
const FormData = require('form-data');
const { validateBufferContent } = require('../../../../../../common/helpers/fileContentValidation');

const CHECK21_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/pdf',
]);

const CHECK21_MAX_BYTES = 10 * 1024 * 1024;

function normalizeMimeType(mimetype, originalname = '') {
  const mime = String(mimetype || '').trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  if (CHECK21_ALLOWED_MIME.has(mime)) return mime === 'image/jpg' ? 'image/jpeg' : mime;

  const name = String(originalname || '').toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return mime;
}

function extensionForMime(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'jpg';
}

function extensionFromName(originalname = '', mimeType = '') {
  const name = String(originalname || '').toLowerCase();
  if (name.endsWith('.png')) return '.png';
  if (name.endsWith('.pdf')) return '.pdf';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'application/pdf') return '.pdf';
  return '.jpg';
}

function assertCheck21ImageFile(file, label = 'check image') {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    const err = new Error(`${label} is required.`);
    err.statusCode = 400;
    throw err;
  }
  if (file.buffer.length > CHECK21_MAX_BYTES) {
    const err = new Error(`${label} must be under 10MB.`);
    err.statusCode = 400;
    throw err;
  }
  const mime = normalizeMimeType(file.mimetype, file.originalname);
  const resolved = mime === 'image/jpg' ? 'image/jpeg' : mime;
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(resolved)) {
    const err = new Error(`${label} must be JPG, PNG, or PDF.`);
    err.statusCode = 400;
    throw err;
  }

  const ext = extensionFromName(file.originalname, resolved);
  const contentCheck = validateBufferContent(file.buffer, ext, resolved);
  if (!contentCheck.valid) {
    const err = new Error(
      `${label} content does not match a valid ${resolved === 'application/pdf' ? 'PDF' : 'image'} file.`,
    );
    err.statusCode = 400;
    throw err;
  }

  return { buffer: file.buffer, mimeType: resolved, originalname: file.originalname || '' };
}

function bufferToDataUri(buffer, mimeType) {
  const mime = normalizeMimeType(mimeType) || 'image/jpeg';
  const resolved = mime === 'image/jpg' ? 'image/jpeg' : mime;
  return `data:${resolved};base64,${buffer.toString('base64')}`;
}

function fileToCheckImageDataUri(file, label) {
  const { buffer, mimeType } = assertCheck21ImageFile(file, label);
  return bufferToDataUri(buffer, mimeType);
}

function assertProcessingAccountId(processingAccountId) {
  const accountId = String(processingAccountId || '').trim();
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    const err = new Error('A valid Payload processing account is required for Check21.');
    err.statusCode = 422;
    throw err;
  }
  return accountId;
}

function normalizeOptionalAmount(amount) {
  if (amount == null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('Amount must be a positive number when provided.');
    err.statusCode = 400;
    throw err;
  }
  return Math.round(n * 100) / 100;
}

function buildCheck21OrderNumber(invoiceId, attemptId) {
  const inv = String(invoiceId || '').replace(/[^a-fA-F0-9]/g, '').slice(-12) || 'inv';
  const att = crypto
    .createHash('sha256')
    .update(String(attemptId || Date.now()))
    .digest('hex')
    .slice(0, 8);
  return `c21_${inv}_${att}`.slice(0, 64);
}

function buildCheck21MultipartForm({
  processingAccountId,
  frontFile,
  backFile,
  amount = null,
  description = '',
  orderNumber = null,
  localAttrs = null,
} = {}) {
  const accountId = assertProcessingAccountId(processingAccountId);
  const front = assertCheck21ImageFile(frontFile, 'Check front');
  const back = assertCheck21ImageFile(backFile, 'Check back');

  if (front.buffer.equals(back.buffer)) {
    const err = new Error('Check front and back images must be different files.');
    err.statusCode = 400;
    throw err;
  }

  const normalizedAmount = normalizeOptionalAmount(amount);
  const desc = String(description || 'Check21 deposit').trim().slice(0, 128);
  const order = orderNumber ? String(orderNumber).trim().slice(0, 64) : '';

  const form = new FormData();
  form.append('type', 'payment');
  form.append('source', 'check');
  form.append('processing_id', accountId);
  form.append('description', desc);
  if (order) form.append('order_number', order);
  if (normalizedAmount != null) form.append('amount', String(normalizedAmount));

  form.append('check_front[file]', front.buffer, {
    filename: `check_front.${extensionForMime(front.mimeType)}`,
    contentType: front.mimeType,
    knownLength: front.buffer.length,
  });
  form.append('check_back[file]', back.buffer, {
    filename: `check_back.${extensionForMime(back.mimeType)}`,
    contentType: back.mimeType,
    knownLength: back.buffer.length,
  });

  return {
    form,
    meta: {
      type: 'payment',
      source: 'check',
      processing_id: accountId,
      amount: normalizedAmount,
      description: desc,
      order_number: order || null,
      check_front: { mimeType: front.mimeType, bytes: front.buffer.length },
      check_back: { mimeType: back.mimeType, bytes: back.buffer.length },
      localAttrs: localAttrs && typeof localAttrs === 'object'
        ? localAttrs
        : { propmv_check21: '1' },
    },
  };
}

function buildCheck21TransactionBody({
  processingAccountId,
  frontDataUri,
  backDataUri,
  amount = null,
  description = '',
} = {}) {
  const accountId = assertProcessingAccountId(processingAccountId);
  if (!frontDataUri || !String(frontDataUri).startsWith('data:')) {
    const err = new Error('Check front image is required.');
    err.statusCode = 400;
    throw err;
  }
  if (!backDataUri || !String(backDataUri).startsWith('data:')) {
    const err = new Error('Check back image is required.');
    err.statusCode = 400;
    throw err;
  }

  const body = {
    type: 'payment',
    source: 'check',
    processing_id: accountId,
    check_front: { file: { data_uri: String(frontDataUri) } },
    check_back: { file: { data_uri: String(backDataUri) } },
    description: String(description || 'Check21 deposit').trim().slice(0, 128),
    attrs: { propmv_check21: '1' },
  };

  const normalizedAmount = normalizeOptionalAmount(amount);
  if (normalizedAmount != null) body.amount = normalizedAmount;
  return body;
}

function flattenPayloadErrorDetails(details, depth = 0) {
  if (details == null || depth > 4) return '';
  if (typeof details === 'string' || typeof details === 'number' || typeof details === 'boolean') {
    const s = String(details);
    if (s.startsWith('data:')) return '[redacted]';
    return s;
  }
  if (Array.isArray(details)) {
    return details.map((d) => flattenPayloadErrorDetails(d, depth + 1)).filter(Boolean).join('; ');
  }
  if (typeof details === 'object') {
    return Object.entries(details)
      .map(([k, v]) => {
        const nested = flattenPayloadErrorDetails(v, depth + 1);
        return nested ? `${k}: ${nested}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

function sanitizePayloadErrorForLog(raw) {
  if (!raw || typeof raw !== 'object') return raw == null ? null : { message: String(raw).slice(0, 200) };
  return {
    object: raw.object || undefined,
    error_type: raw.error_type || undefined,
    error_description: raw.error_description || undefined,
    details: flattenPayloadErrorDetails(raw.details) || undefined,
  };
}

function toCheck21UserFriendlyMessage(status, detail, raw = null) {
  const message = String(detail || '').trim();
  const lower = message.toLowerCase();
  const detailsFlat = flattenPayloadErrorDetails(raw?.details || {}).toLowerCase();
  const combined = `${lower} ${detailsFlat}`;

  if (combined.includes('same as the front')) {
    return 'Check front and back images must be different. Upload a separate image of the back of the check.';
  }
  if (combined.includes('unreadable') || combined.includes('invalid or unreadable check')) {
    return 'Payload could not read the check images. Use clear JPG/PNG/PDF photos of a real check (front MICR line visible, back endorsement visible), under 10MB each.';
  }
  if (combined.includes('check_front') || combined.includes('check_back') || combined.includes('check_images')) {
    return message && !message.startsWith('Invalid Payload') && message.length < 220
      ? `Check21 submission failed: ${message}`
      : 'Check21 submission failed. Verify both front and back check images and try again.';
  }
  if (combined.includes('processing_id') || combined.includes('processing account')) {
    return 'The selected HOA processing account could not be used for Check21. Confirm Bank Accounts onboarding is complete and active.';
  }
  if (status === 401) {
    return 'Payload rejected the server API key. Ask your platform admin to verify PAYLOAD_SECRET_KEY.';
  }
  if (status === 404) {
    return 'The selected Payload processing account was not found.';
  }
  if (status === 429) {
    return 'Payload is busy right now. Please wait a moment and try again.';
  }
  if (status >= 500 || combined.includes('unreachable') || combined.includes('etimedout')) {
    return message && !message.startsWith('Invalid Payload') && message.length < 220
      ? message
      : 'Payload could not process this Check21 deposit right now. Please try again shortly.';
  }
  if (message && !message.startsWith('Invalid Payload') && message.length < 220) {
    if (lower.includes('saved payment method') || lower.includes('re-add the payment method')) {
      return 'Check21 submission was rejected by Payload. Verify both check images and the processing account, then try again.';
    }
    return message;
  }
  return 'Unable to submit Check21 payment.';
}

module.exports = {
  CHECK21_ALLOWED_MIME,
  CHECK21_MAX_BYTES,
  normalizeMimeType,
  assertCheck21ImageFile,
  bufferToDataUri,
  fileToCheckImageDataUri,
  buildCheck21MultipartForm,
  buildCheck21TransactionBody,
  buildCheck21OrderNumber,
  flattenPayloadErrorDetails,
  sanitizePayloadErrorForLog,
  toCheck21UserFriendlyMessage,
};
