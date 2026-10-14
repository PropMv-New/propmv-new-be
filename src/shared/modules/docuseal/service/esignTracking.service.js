const mongoose = require('mongoose');
const logger = require('../../../../common/logger');
const EsignSigningRecord = require('../model/esignSigningRecord.model');
const docusealService = require('./docuseal.service');
const s3Client = require('../../../../integrations/s3');

const MAX_WEBHOOK_EVENTS = 40;

function normalizeSubmitterStatus(raw) {
  const value = String(raw || '').toLowerCase().trim();
  if (['completed', 'complete', 'signed'].includes(value)) return 'completed';
  if (['declined', 'rejected'].includes(value)) return 'declined';
  if (['opened', 'viewed'].includes(value)) return 'opened';
  if (['sent'].includes(value)) return 'sent';
  if (['awaiting', 'pending', 'invitation_sent'].includes(value)) return 'awaiting';
  return 'awaiting';
}

function mapSubmittersFromSendPayload(payload = {}) {
  const sendSubmitters = Array.isArray(payload.submitters) ? payload.submitters : [];
  const templateSubmitters = Array.isArray(payload.template_submitters)
    ? payload.template_submitters
    : [];

  const roleByUuid = new Map();
  for (const ts of templateSubmitters) {
    if (ts?.uuid) roleByUuid.set(String(ts.uuid), ts.name || ts.role || null);
  }

  return sendSubmitters
    .filter((s) => s && (s.email || s.id || s.uuid))
    .map((s) => ({
      docusealSubmitterId: s.id != null ? Number(s.id) : null,
      uuid: s.uuid || null,
      email: String(s.email || '').toLowerCase().trim() || 'unknown@unknown',
      name: s.name || null,
      role: roleByUuid.get(String(s.uuid)) || s.role || null,
      phone: s.phone || null,
      status: normalizeSubmitterStatus(s.status),
      sentAt: s.sent_at ? new Date(s.sent_at) : null,
      openedAt: s.opened_at ? new Date(s.opened_at) : null,
      completedAt: s.completed_at ? new Date(s.completed_at) : null,
      declinedAt: s.declined_at ? new Date(s.declined_at) : null,
      externalId: s.external_id || null,
    }));
}

function mapSubmittersFromDocusealSubmission(submission = {}) {
  const list = Array.isArray(submission.submitters) ? submission.submitters : [];
  return list.map((s) => ({
    docusealSubmitterId: s.id != null ? Number(s.id) : null,
    uuid: s.uuid || null,
    email: String(s.email || '').toLowerCase().trim() || 'unknown@unknown',
    name: s.name || null,
    role: s.role || null,
    phone: s.phone || null,
    status: normalizeSubmitterStatus(s.status),
    sentAt: s.sent_at ? new Date(s.sent_at) : null,
    openedAt: s.opened_at ? new Date(s.opened_at) : null,
    completedAt: s.completed_at ? new Date(s.completed_at) : null,
    declinedAt: s.declined_at ? new Date(s.declined_at) : null,
    externalId: s.external_id || null,
  }));
}

function computeOverallStatus(submitters = [], docusealStatus) {
  const ds = String(docusealStatus || '').toLowerCase();
  if (ds === 'expired') return 'expired';
  if (ds === 'archived') return 'archived';
  if (ds === 'declined') return 'declined';
  if (ds === 'completed') return 'completed';

  if (!submitters.length) return 'pending';

  const declined = submitters.some((s) => s.status === 'declined');
  if (declined) return 'declined';

  const allCompleted = submitters.every((s) => s.status === 'completed');
  if (allCompleted) return 'completed';

  const anyProgress = submitters.some((s) =>
    ['sent', 'opened', 'completed'].includes(s.status)
  );
  if (anyProgress) return 'in_progress';

  return 'pending';
}

function applyCounts(record) {
  const submitters = record.submitters || [];
  record.totalSigners = submitters.length;
  record.signedCount = submitters.filter((s) => s.status === 'completed').length;
  record.declinedCount = submitters.filter((s) => s.status === 'declined').length;
  if (record.status === 'completed' && !record.completedAt) {
    record.completedAt = new Date();
  }
}

function humanWebhookSummary(eventType, extra = {}) {
  const type = String(eventType || '').toLowerCase();
  const who = extra.email ? String(extra.email).trim() : '';
  if (type === 'form.viewed') {
    return who ? `${who} opened the document.` : 'A signer opened the document.';
  }
  if (type === 'form.started') {
    return who ? `${who} started signing the document.` : 'A signer started signing the document.';
  }
  if (type === 'form.completed') {
    return who ? `${who} signed the document.` : 'A signer signed the document.';
  }
  if (type === 'form.declined') {
    return who ? `${who} declined to sign.` : 'A signer declined to sign.';
  }
  if (type === 'submission.created') return 'This e-sign request was created.';
  if (type === 'submission.completed') {
    return 'All required signatures have been collected. This request is complete.';
  }
  if (type === 'submission.expired') {
    return 'This request expired before everyone could sign.';
  }
  if (type === 'submission.archived') return 'This request was archived.';
  if (type === 'invite.resent') {
    return who
      ? `A signing invitation was sent again to ${who}.`
      : 'A signing invitation was sent again.';
  }
  return extra.note || null;
}

function extractDocusealEventTime(eventType, data = {}) {
  const type = String(eventType || '').toLowerCase();
  const candidates = [];
  if (type === 'form.viewed') candidates.push(data.opened_at, data.updated_at);
  if (type === 'form.started') candidates.push(data.updated_at, data.opened_at, data.started_at);
  if (type === 'form.completed') candidates.push(data.completed_at, data.updated_at);
  if (type === 'form.declined') candidates.push(data.declined_at, data.updated_at);
  if (type === 'submission.created') candidates.push(data.created_at);
  if (type === 'submission.completed') candidates.push(data.completed_at, data.updated_at);
  if (type === 'submission.expired') candidates.push(data.expired_at, data.updated_at);
  if (type === 'submission.archived') candidates.push(data.archived_at, data.updated_at);
  candidates.push(data.updated_at, data.created_at, data.occurred_at, data.timestamp);

  for (const value of candidates) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function pushWebhookEvent(record, eventType, summary, occurredAt) {
  const events = Array.isArray(record.webhookEvents) ? record.webhookEvents : [];
  const receivedAt =
    occurredAt instanceof Date && !Number.isNaN(occurredAt.getTime())
      ? occurredAt
      : occurredAt
        ? new Date(occurredAt)
        : new Date();
  events.push({
    eventType: String(eventType || 'unknown'),
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    summary: summary || null,
  });
  record.webhookEvents = events.slice(-MAX_WEBHOOK_EVENTS);
  record.lastWebhookAt = new Date();
  record.lastWebhookEvent = String(eventType || 'unknown');
}

function serializeSubmitter(submitter = {}) {
  return {
    email: submitter.email,
    name: submitter.name || null,
    role: submitter.role || null,
    status: submitter.status,
    sentAt: submitter.sentAt || null,
    openedAt: submitter.openedAt || null,
    completedAt: submitter.completedAt || null,
    declinedAt: submitter.declinedAt || null,
  };
}

function serializeWebhookEvent(event = {}, index = 0) {
  return {
    id: `${event.receivedAt || index}-${event.eventType || 'event'}`,
    eventType: event.eventType || 'unknown',
    receivedAt: event.receivedAt || null,
    summary: event.summary || null,
  };
}

function idsEqual(left, right) {
  const a = left != null ? String(left).trim() : '';
  const b = right != null ? String(right).trim() : '';
  return Boolean(a && b && a === b);
}

function signingRecordNotFound() {
  const err = new Error('Signing record not found');
  err.statusCode = 404;
  return err;
}

async function findActiveRecordById(id) {
  const raw = String(id || '').trim();
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  return EsignSigningRecord.findOne({
    _id: raw,
    isDeleted: { $ne: true },
  });
}

function assertCanAccessRecord(record, { userId, companyId, hoaId } = {}) {
  if (idsEqual(record.sentByUserId, userId)) return;

  if (hoaId) {
    if (idsEqual(record.hoaId, hoaId)) return;
    // Webhook-first rows often have no sender/HOA until the portal send persists them.
    if (!record.hoaId && !record.sentByUserId && userId) return;
    throw signingRecordNotFound();
  }

  if (companyId && record.companyId && !idsEqual(record.companyId, companyId)) {
    throw signingRecordNotFound();
  }

  if (!companyId && userId) {
    throw signingRecordNotFound();
  }
}

function applySenderScope(record, { user, authUser, body = {} } = {}) {
  const sentByUserId = user?._id || user?.id || authUser?._id || null;
  if (!record.sentByUserId && sentByUserId) {
    record.sentByUserId = sentByUserId;
  }
  if (body.hoaId) record.hoaId = body.hoaId;
  if (body.portal) record.portal = body.portal;
  if (!record.companyId && (authUser?.companyId || body.companyId)) {
    record.companyId = authUser?.companyId || body.companyId;
  }
  return record;
}

async function claimUnscopedRecord(record, { userId, companyId, hoaId } = {}) {
  let dirty = false;
  if (userId && !record.sentByUserId) {
    record.sentByUserId = userId;
    dirty = true;
  }
  if (hoaId && !record.hoaId) {
    record.hoaId = hoaId;
    if (!record.portal) record.portal = 'hoa';
    dirty = true;
  }
  if (companyId && !record.companyId) {
    record.companyId = companyId;
    dirty = true;
  }
  if (dirty) await record.save();
  return record;
}

function serializeRecord(record, { includeActivity = false } = {}) {
  if (!record) return null;
  const obj = typeof record.toObject === 'function' ? record.toObject() : { ...record };
  const payload = {
    id: String(obj._id),
    portal: obj.portal || null,
    sentByEmail: obj.sentByEmail,
    sentByName: obj.sentByName || null,
    documentName: obj.documentName,
    status: obj.status,
    submitters: (obj.submitters || []).map(serializeSubmitter),
    signedCount: obj.signedCount || 0,
    totalSigners: obj.totalSigners || 0,
    declinedCount: obj.declinedCount || 0,
    completedAt: obj.completedAt || null,
    expiredAt: obj.expiredAt || null,
    archivedAt: obj.archivedAt || null,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    hasAuditLog: Boolean(obj.auditLogS3Key || obj.auditLogUrl),
  };

  if (includeActivity) {
    payload.webhookEvents = (obj.webhookEvents || []).map(serializeWebhookEvent);
  }

  return payload;
}

/**
 * Persist a signing request after DocuSeal builder onSend.
 */
async function createFromSendPayload({ user, authUser, body = {} }) {
  const payload = body.sendPayload || body;
  const submissionId = Number(payload.id || body.docusealSubmissionId);
  if (!Number.isFinite(submissionId)) {
    const err = new Error('DocuSeal submission id is required');
    err.statusCode = 400;
    throw err;
  }

  const template = payload.template || {};
  const documentName =
    body.documentName ||
    template.name ||
    body.name ||
    `Document ${submissionId}`;

  const submitters = mapSubmittersFromSendPayload(payload);
  const status = computeOverallStatus(submitters, payload.status);

  const sentByEmail =
    (authUser && authUser.email) ||
    body.sentByEmail ||
    user?.email ||
    'unknown@unknown';
  const sentByName =
    body.sentByName ||
    [authUser?.firstName, authUser?.lastName].filter(Boolean).join(' ') ||
    authUser?.name ||
    null;

  const templateId = Number(template.id || body.templateId);
  if (!templateId || !Number.isFinite(templateId)) {
    const err = new Error('template id is required on send payload');
    err.statusCode = 400;
    throw err;
  }

  const existing = await EsignSigningRecord.findOne({ docusealSubmissionId: submissionId });
  if (existing && !existing.isDeleted) {
    existing.submitters = submitters.length ? submitters : existing.submitters;
    existing.status = computeOverallStatus(existing.submitters, payload.status);
    existing.documentName = documentName;
    existing.templateId = templateId;
    existing.rawSendPayload = payload;
    applySenderScope(existing, { user, authUser, body });
    if (!existing.sentByEmail || existing.sentByEmail === 'webhook@system.local') {
      existing.sentByEmail = String(sentByEmail).toLowerCase().trim();
      existing.sentByName = sentByName;
    }
    applyCounts(existing);
    await existing.save();
    return serializeRecord(existing);
  }

  const record = new EsignSigningRecord({
    companyId: authUser?.companyId || body.companyId || null,
    hoaId: body.hoaId || authUser?.hoaId || null,
    portal: body.portal || (body.hoaId ? 'hoa' : null),
    sentByUserId: user?._id || user?.id || authUser?._id || null,
    sentByEmail: String(sentByEmail).toLowerCase().trim(),
    sentByName,
    documentName,
    templateId,
    templateExternalId: template.external_id || body.templateExternalId || null,
    docusealSubmissionId: submissionId,
    submissionSlug: payload.slug || null,
    submissionSource: body.source || 'builder',
    status,
    submitters,
    rawSendPayload: payload,
  });

  if (!record.sentByUserId) {
    const err = new Error('Authenticated user is required to create a signing record');
    err.statusCode = 401;
    throw err;
  }

  applyCounts(record);
  await record.save();

  // Best-effort enrich from DocuSeal API (status, audit url, etc.)
  try {
    await refreshFromDocuseal(record.docusealSubmissionId);
  } catch (err) {
    logger.warn('[DocuSeal] post-create refresh failed:', err.message);
  }

  const fresh = await EsignSigningRecord.findById(record._id);
  return serializeRecord(fresh || record);
}

async function listRecords({ userId, companyId, hoaId, status, limit = 50, skip = 0 }) {
  const query = { isDeleted: { $ne: true } };
  if (hoaId) {
    query.$or = [
      { hoaId },
      { sentByUserId: userId, hoaId: null },
    ];
  } else if (companyId) {
    query.companyId = companyId;
  } else if (userId) {
    query.sentByUserId = userId;
  }
  if (status) query.status = status;

  const [items, total] = await Promise.all([
    EsignSigningRecord.find(query)
      .sort({ createdAt: -1 })
      .skip(Number(skip) || 0)
      .limit(Math.min(Number(limit) || 50, 100))
      .lean(),
    EsignSigningRecord.countDocuments(query),
  ]);

  return {
    items: items.map((item) => serializeRecord(item)),
    total,
    limit: Math.min(Number(limit) || 50, 100),
    skip: Number(skip) || 0,
  };
}

async function getRecordById(id, { userId, companyId, hoaId } = {}) {
  const record = await findActiveRecordById(id);
  if (!record) throw signingRecordNotFound();

  assertCanAccessRecord(record, { userId, companyId, hoaId });
  await claimUnscopedRecord(record, { userId, companyId, hoaId });
  return serializeRecord(record, { includeActivity: true });
}

async function refreshRecordById(id, auth = {}) {
  const record = await findActiveRecordById(id);
  if (!record) throw signingRecordNotFound();

  assertCanAccessRecord(record, auth);
  await claimUnscopedRecord(record, auth);
  const updated = await refreshFromDocuseal(record.docusealSubmissionId);
  return serializeRecord(updated || record, { includeActivity: true });
}

function findSignerByEmail(record, email) {
  const target = String(email || '').toLowerCase().trim();
  if (!target) return -1;
  return (record.submitters || []).findIndex(
    (signer) => String(signer.email || '').toLowerCase() === target
  );
}

async function resendInvite(id, { email } = {}, auth = {}) {
  const record = await findActiveRecordById(id);
  if (!record) throw signingRecordNotFound();

  assertCanAccessRecord(record, auth);
  await claimUnscopedRecord(record, auth);

  const targetEmail = String(email || '').toLowerCase().trim();
  if (!targetEmail) {
    const err = new Error('Signer email is required');
    err.statusCode = 400;
    throw err;
  }

  const recordStatus = String(record.status || '').toLowerCase();
  if (['completed', 'expired', 'archived'].includes(recordStatus)) {
    const err = new Error('This request can no longer receive signing invitations.');
    err.statusCode = 400;
    throw err;
  }

  let working = record;
  let signerIndex = findSignerByEmail(working, targetEmail);
  if (signerIndex < 0) {
    const err = new Error('Signer not found on this request');
    err.statusCode = 404;
    throw err;
  }

  if (String(working.submitters[signerIndex].status || '').toLowerCase() === 'completed') {
    const err = new Error('This signer has already completed their signature.');
    err.statusCode = 400;
    throw err;
  }

  let submitterId = working.submitters[signerIndex].docusealSubmitterId;
  if (!submitterId && working.docusealSubmissionId) {
    working = (await refreshFromDocuseal(working.docusealSubmissionId)) || working;
    signerIndex = findSignerByEmail(working, targetEmail);
    submitterId = signerIndex >= 0 ? working.submitters[signerIndex].docusealSubmitterId : null;
  }

  if (!submitterId) {
    const err = new Error('Unable to resend this invitation. The signer is not linked yet.');
    err.statusCode = 409;
    throw err;
  }

  await docusealService.resendSubmitterEmail(submitterId);

  signerIndex = findSignerByEmail(working, targetEmail);
  if (signerIndex >= 0) {
    working.submitters[signerIndex].sentAt = new Date();
    if (String(working.submitters[signerIndex].status || '').toLowerCase() === 'awaiting') {
      working.submitters[signerIndex].status = 'sent';
    }
  }
  pushWebhookEvent(
    working,
    'invite.resent',
    `Invitation resent to ${targetEmail}`,
    new Date()
  );
  await working.save();

  return serializeRecord(working, { includeActivity: true });
}

async function findBySubmissionId(submissionId) {
  return EsignSigningRecord.findOne({
    docusealSubmissionId: Number(submissionId),
    isDeleted: false,
  });
}

async function findBySubmitterId(submitterId) {
  return EsignSigningRecord.findOne({
    'submitters.docusealSubmitterId': Number(submitterId),
    isDeleted: false,
  });
}

/**
 * Pull latest submission from DocuSeal and update local record.
 */
async function refreshFromDocuseal(submissionId) {
  const submission = await docusealService.getSubmission(submissionId);
  const record = await findBySubmissionId(submissionId);
  if (!record) return null;

  const submitters = mapSubmittersFromDocusealSubmission(submission);
  if (submitters.length) record.submitters = submitters;

  record.status = computeOverallStatus(record.submitters, submission.status);
  record.submissionSlug = submission.slug || record.submissionSlug;
  record.auditLogUrl = submission.audit_log_url || record.auditLogUrl;
  record.combinedDocumentUrl =
    submission.combined_document_url || record.combinedDocumentUrl;
  if (submission.completed_at) record.completedAt = new Date(submission.completed_at);
  if (submission.archived_at) {
    record.archivedAt = new Date(submission.archived_at);
    record.status = 'archived';
  }
  record.lastDocusealSnapshot = {
    id: submission.id,
    status: submission.status,
    audit_log_url: submission.audit_log_url || null,
    combined_document_url: submission.combined_document_url || null,
    updated_at: submission.updated_at || null,
  };
  applyCounts(record);
  await record.save();

  if (record.status === 'completed' && record.auditLogUrl && !record.auditLogS3Key) {
    await storeAuditLogToS3(record).catch((err) => {
      logger.warn('[DocuSeal] audit log S3 store failed:', err.message);
    });
  }

  return record;
}

/**
 * Download DocuSeal audit log (when URL present) and store in S3.
 */
async function storeAuditLogToS3(record) {
  if (!record?.auditLogUrl) return record;
  if (record.auditLogS3Key) return record;

  const response = await fetch(record.auditLogUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audit log (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) {
    throw new Error('Audit log file was empty');
  }

  const contentType = response.headers.get('content-type') || 'application/pdf';
  const ext = contentType.includes('pdf') ? 'pdf' : 'bin';
  const filename = `audit-log-submission-${record.docusealSubmissionId}.${ext}`;
  const key = s3Client.getKey(
    'esign-audit',
    filename,
    record.sentByUserId ? String(record.sentByUserId) : undefined
  );

  const uploaded = await s3Client.upload(key, buffer);
  record.auditLogS3Key = uploaded.Key || key;
  record.auditLogS3Location = uploaded.Location || null;
  record.auditLogStoredAt = new Date();
  await record.save();

  logger.info('[DocuSeal] audit log stored to S3', {
    submissionId: record.docusealSubmissionId,
    key: record.auditLogS3Key,
  });

  return record;
}

function mergeSubmitter(existing, incoming) {
  if (!incoming) return existing;
  const next = { ...(existing || {}) };
  if (incoming.id != null) next.docusealSubmitterId = Number(incoming.id);
  if (incoming.uuid) next.uuid = incoming.uuid;
  if (incoming.email) next.email = String(incoming.email).toLowerCase().trim();
  if (incoming.name) next.name = incoming.name;
  if (incoming.role) next.role = incoming.role;
  if (incoming.phone) next.phone = incoming.phone;
  if (incoming.status) next.status = normalizeSubmitterStatus(incoming.status);
  if (incoming.sent_at) next.sentAt = new Date(incoming.sent_at);
  if (incoming.opened_at) next.openedAt = new Date(incoming.opened_at);
  if (incoming.completed_at) next.completedAt = new Date(incoming.completed_at);
  if (incoming.declined_at) next.declinedAt = new Date(incoming.declined_at);
  if (incoming.external_id) next.externalId = incoming.external_id;
  return next;
}

/**
 * DocuSeal form webhooks nest submission under data.submission.id.
 * Older/alternate payloads may use data.submission_id or top-level data.id.
 */
function extractSubmissionId(eventType, data = {}) {
  const nested = data.submission?.id ?? data.submission?.submission_id;
  if (nested != null && Number.isFinite(Number(nested))) return Number(nested);
  if (data.submission_id != null && Number.isFinite(Number(data.submission_id))) {
    return Number(data.submission_id);
  }
  if (eventType.startsWith('submission.') && data.id != null && Number.isFinite(Number(data.id))) {
    return Number(data.id);
  }
  return null;
}

/**
 * Handle DocuSeal webhook event payloads.
 * Supported: form.*, submission.*, template.*
 */
async function handleWebhookEvent(payload = {}) {
  const eventType = String(payload.event_type || payload.event || '').trim();
  const data = payload.data || payload;

  if (!eventType) {
    const err = new Error('Missing event_type');
    err.statusCode = 400;
    throw err;
  }

  // Template events - acknowledge only (no signing record)
  if (eventType.startsWith('template.')) {
    logger.info('[DocuSeal] template webhook ignored for signing tracker', { eventType });
    return { handled: true, ignored: true, eventType };
  }

  let record = null;
  let submissionId = extractSubmissionId(eventType, data);
  const nestedSubmission = data.submission && typeof data.submission === 'object' ? data.submission : null;

  if (eventType.startsWith('form.')) {
    // form.* payload is a submitter; submission id lives at data.submission.id
    const submitterId = data.id != null ? Number(data.id) : null;

    if (!submissionId && !submitterId && !data.email && !data.uuid) {
      const err = new Error(
        'Webhook data is empty. Pass DocuSeal form payload with data.submission.id (or data.id / email), or use submission.completed with data.id.'
      );
      err.statusCode = 400;
      throw err;
    }

    if (submissionId) record = await findBySubmissionId(submissionId);
    if (!record && submitterId) record = await findBySubmitterId(submitterId);
    if (!record && data.email) {
      record = await EsignSigningRecord.findOne({
        'submitters.email': String(data.email).toLowerCase().trim(),
        isDeleted: false,
        status: { $in: ['pending', 'in_progress'] },
      }).sort({ updatedAt: -1 });
      if (record && !submissionId) submissionId = record.docusealSubmissionId;
    }

    if (!record && submissionId) {
      // Late webhook before UI persisted - try create skeleton from DocuSeal
      try {
        await refreshOrCreateFromDocuseal(submissionId, {
          eventType,
          note: 'auto-created from form webhook',
        });
        record = await findBySubmissionId(submissionId);
      } catch (err) {
        logger.warn('[DocuSeal] could not auto-create record from form webhook:', err.message);
      }
    }

    if (record) {
      submissionId = submissionId || record.docusealSubmissionId;
      const idx = (record.submitters || []).findIndex(
        (s) =>
          (submitterId && Number(s.docusealSubmitterId) === submitterId) ||
          (data.uuid && s.uuid === data.uuid) ||
          (data.email &&
            String(s.email).toLowerCase() === String(data.email).toLowerCase())
      );

      if (idx >= 0) {
        record.submitters[idx] = mergeSubmitter(record.submitters[idx], data);
      } else if (data.email || data.id) {
        record.submitters.push(mergeSubmitter({}, data));
      }

      // Map form events onto submitter status if status missing
      if (idx >= 0 || record.submitters.length) {
        const target =
          idx >= 0 ? record.submitters[idx] : record.submitters[record.submitters.length - 1];
        if (eventType === 'form.viewed' || eventType === 'form.started') {
          if (target.status === 'awaiting' || target.status === 'sent') {
            target.status = 'opened';
            target.openedAt = target.openedAt || new Date();
          }
        }
        if (eventType === 'form.completed') {
          target.status = 'completed';
          target.completedAt = target.completedAt || new Date();
        }
        if (eventType === 'form.declined') {
          target.status = 'declined';
          target.declinedAt = target.declinedAt || new Date();
        }
      }

      if (nestedSubmission?.audit_log_url) {
        record.auditLogUrl = nestedSubmission.audit_log_url;
      } else if (data.audit_log_url) {
        record.auditLogUrl = data.audit_log_url;
      }
      if (nestedSubmission?.combined_document_url) {
        record.combinedDocumentUrl = nestedSubmission.combined_document_url;
      }

      const submissionStatus = nestedSubmission?.status || null;
      record.status = computeOverallStatus(record.submitters, submissionStatus);
      applyCounts(record);
      pushWebhookEvent(
        record,
        eventType,
        humanWebhookSummary(eventType, { email: data.email }),
        extractDocusealEventTime(eventType, data)
      );
      await record.save();

      // Authoritative sync from DocuSeal whenever we know the submission id
      if (submissionId) {
        try {
          const refreshed = await refreshFromDocuseal(submissionId);
          if (refreshed) record = refreshed;
        } catch (err) {
          logger.warn('[DocuSeal] refresh after form webhook failed:', err.message);
        }
      }
    }
  }

  if (eventType.startsWith('submission.')) {
    submissionId = extractSubmissionId(eventType, data) || submissionId;
    if (!submissionId) {
      const err = new Error(
        'submission id missing in webhook (expected data.id for submission.* events)'
      );
      err.statusCode = 400;
      throw err;
    }

    record = await findBySubmissionId(submissionId);
    if (!record) {
      try {
        record = await refreshOrCreateFromDocuseal(submissionId, {
          eventType,
          note: 'auto-created from submission webhook',
        });
      } catch (err) {
        logger.warn('[DocuSeal] auto-create from submission webhook failed:', err.message);
      }
    }

    if (record) {
      if (Array.isArray(data.submitters) && data.submitters.length) {
        record.submitters = mapSubmittersFromDocusealSubmission(data);
      }
      if (data.audit_log_url) record.auditLogUrl = data.audit_log_url;
      if (data.combined_document_url) {
        record.combinedDocumentUrl = data.combined_document_url;
      }
      if (data.slug) record.submissionSlug = data.slug;

      if (eventType === 'submission.expired') {
        record.status = 'expired';
        record.expiredAt = new Date();
      } else if (eventType === 'submission.archived') {
        record.status = 'archived';
        record.archivedAt = data.archived_at ? new Date(data.archived_at) : new Date();
      } else if (eventType === 'submission.completed') {
        record.status = 'completed';
        record.completedAt = data.completed_at ? new Date(data.completed_at) : new Date();
        if (Array.isArray(record.submitters) && record.submitters.length) {
          record.submitters = record.submitters.map((s) => ({
            ...(typeof s.toObject === 'function' ? s.toObject() : s),
            status: s.status === 'declined' ? 'declined' : 'completed',
            completedAt: s.completedAt || new Date(),
          }));
        }
      } else {
        record.status = computeOverallStatus(record.submitters, data.status);
      }

      applyCounts(record);
      pushWebhookEvent(
        record,
        eventType,
        humanWebhookSummary(eventType),
        extractDocusealEventTime(eventType, data)
      );
      record.lastDocusealSnapshot = {
        id: data.id,
        status: data.status,
        audit_log_url: data.audit_log_url || null,
        eventType,
      };
      await record.save();

      try {
        // Prefer fresh API data for status + audit_log_url
        const refreshed = await refreshFromDocuseal(submissionId);
        if (refreshed) record = refreshed;
      } catch (err) {
        logger.warn('[DocuSeal] audit refresh on submission webhook failed:', err.message);
        if (record.auditLogUrl && !record.auditLogS3Key) {
          await storeAuditLogToS3(record).catch((e) =>
            logger.warn('[DocuSeal] audit S3 store failed:', e.message)
          );
        }
      }
    }
  }

  if (!record) {
    logger.warn('[DocuSeal] webhook matched no signing record', {
      eventType,
      submissionId,
      submitterId: data?.id ?? null,
    });
  }

  return {
    handled: true,
    eventType,
    submissionId: submissionId || null,
    recordId: record?._id ? String(record._id) : null,
    status: record?.status || null,
    matched: Boolean(record),
  };
}

/**
 * Create a minimal local record from DocuSeal submission when webhook arrives first.
 */
async function refreshOrCreateFromDocuseal(submissionId, meta = {}) {
  const submission = await docusealService.getSubmission(submissionId);
  let record = await findBySubmissionId(submissionId);

  if (!record) {
    const submitters = mapSubmittersFromDocusealSubmission(submission);
    const User = require('../../users/models/user.model');
    let sentByEmail = 'webhook@system.local';
    let sentByName = 'DocuSeal Webhook';
    let sentByUserId = null;
    let companyId = null;

    if (submission.created_by_user?.email) {
      sentByEmail = String(submission.created_by_user.email).toLowerCase();
      sentByName =
        [submission.created_by_user.first_name, submission.created_by_user.last_name]
          .filter(Boolean)
          .join(' ') || null;
      const sender = await User.findOne({ email: sentByEmail })
        .select('_id email companyId')
        .lean();
      if (sender?._id) {
        sentByUserId = sender._id;
        companyId = sender.companyId || null;
      }
    }

    record = new EsignSigningRecord({
      companyId,
      sentByUserId,
      sentByEmail,
      sentByName,
      documentName: submission.template?.name || `Submission ${submissionId}`,
      templateId: Number(submission.template?.id || 0) || 0,
      templateExternalId: submission.template?.external_id || null,
      docusealSubmissionId: Number(submissionId),
      submissionSlug: submission.slug || null,
      submissionSource: 'webhook',
      status: computeOverallStatus(submitters, submission.status),
      submitters,
      auditLogUrl: submission.audit_log_url || null,
      combinedDocumentUrl: submission.combined_document_url || null,
      rawSendPayload: { autoCreated: true, ...meta },
    });

    applyCounts(record);
    pushWebhookEvent(
      record,
      meta.eventType || 'submission.created',
      humanWebhookSummary(meta.eventType || 'submission.created', { note: meta.note }),
      extractDocusealEventTime(meta.eventType || 'submission.created', submission)
    );
    await record.save();
    return record;
  }

  return refreshFromDocuseal(submissionId);
}

module.exports = {
  createFromSendPayload,
  listRecords,
  getRecordById,
  refreshRecordById,
  resendInvite,
  handleWebhookEvent,
  refreshFromDocuseal,
  storeAuditLogToS3,
  serializeRecord,
  computeOverallStatus,
};
