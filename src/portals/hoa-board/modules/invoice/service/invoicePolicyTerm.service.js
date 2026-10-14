/**
 * ------------------------------------------------------------------
 * File: invoicePolicyTerm.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.service, invoiceGenerationJob.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const path = require('path');
const Invoice = require('../model/invoice.model');
const Property = require('../../property/model/property.model');
const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
const s3Client = require('../../../../../integrations/s3');
const config = require('../../../../../config/default');
const { ClockService, DateUtil } = require('../../../../../common/date');
const fs = require('fs').promises;
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const ledgerService = require('../../owners/services/ledger.service');
const logger = require('../../../../../common/logger');
const { logActivity } = require('../../dashboard/service/activity.service');
const { allocateUniqueInvoiceIds } = require('../helpers/invoiceId.helper');
const { buildCreditAppliedPaymentTransaction } = require('../helpers/invoiceCreditPayment.helper');
const { POLICY_TERM_INSERT_BATCH_SIZE } = require('../constants/policyTerm');
const { assertHoaDocumentUploadSize } = require('../../../../../shared/modules/documents/helpers/hoaDocumentUploadLimits');
const {
  parseDateOnlyToUtcParts,
  firstMonthlyDueDateUtc,
  addUtcCalendarMonths,
} = require('../../owners/services/unitInvoice.service');
const { isDueDateOnOrBeforeToday } = require('../../../../../common/helpers/hoaBillingDates');
const { resolvePaymentDueDayFromSources } = require('../../owners/helpers/paymentDueDay.helper');

const roundCurrency = (value) => Number((value || 0).toFixed(2));

function toObjectId(value) {
  const str = String(
    value && typeof value === 'object' && value._id ? value._id : value ?? ''
  ).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIdArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(toObjectId).filter(Boolean);
}

const uploadBase = path.resolve(
  (config.uploads && config.uploads.base) || path.join(__dirname, '../../../../../uploads')
);

function safeFilePath(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved.startsWith(uploadBase + path.sep) && resolved !== uploadBase) {
    throw Object.assign(new Error('File path escapes upload directory'), { status: 400 });
  }
  return resolved;
}

const resolveInvoiceUnitLabel = (property, unitRef) => {
  if (!unitRef) return 'Unit';
  const ref = String(unitRef);
  const details = (property && property.unitDetails) || [];
  const byId = details.find((d) => d && String(d._id) === ref);
  if (byId && byId.unitName) return String(byId.unitName);
  const byName = details.find((d) => d && String(d.unitName) === ref);
  if (byName && byName.unitName) return String(byName.unitName);
  return ref;
};

async function uploadFilesToS3(files) {
  if (!files || files.length === 0) return [];

  assertHoaDocumentUploadSize(files);

  const uploadedDocs = [];
  for (const file of files) {
    const safeFilename = path.basename(String(file.filename || ''));
    const safePath = safeFilePath(file.path);
    const s3Key = s3Client.getKey('invoice', safeFilename);
    const fileBuffer = await fs.readFile(safePath);
    const s3Result = await s3Client.upload(s3Key, fileBuffer);
    const s3Base = (config.s3 && config.s3.baseUrl) || s3Client.baseUrl || '';
    const fileUrl = s3Result.Location || (s3Base ? `${s3Base}/${s3Result.Key}` : `/${s3Result.Key}`);

    uploadedDocs.push({
      filename: safeFilename,
      originalName: file.originalname,
      key: s3Result.Key,
      url: fileUrl,
      size: file.size,
      mimetype: file.mimetype,
    });

    try {
      await fs.unlink(safePath);
    } catch (err) {
      logger.warn(`Failed to clean up temp file: ${err.message}`);
    }
  }

  return uploadedDocs;
}

async function preparePolicyTermDocumentsPayload(files, userId, session) {
  const createdMetadata = [];
  if (!files || files.length === 0) {
    return { documentsPayload: [], createdMetadata };
  }

  const uploadedDocs = await uploadFilesToS3(files);
  if (!Array.isArray(uploadedDocs) || uploadedDocs.length === 0) {
    return { documentsPayload: [], createdMetadata };
  }

  const cfg = config;
  const bucketName = (cfg.s3 && cfg.s3.bucketName) || process.env.S3_BUCKET || 'mock-bucket';
  const region = (cfg.s3 && cfg.s3.region) || process.env.AWS_REGION || 'mock-region';

  for (const d of uploadedDocs) {
    const metaDocs = await DocumentMetadata.create([{
      key: d.key,
      s3Location: d.url,
      bucketName,
      region,
      size: d.size || 0,
      contentType: d.mimetype || 'application/octet-stream',
      originalName: d.originalName || d.filename,
    }], { session });
    createdMetadata.push(metaDocs[0]);
  }

  const documentsPayload = createdMetadata.map((md) => ({
    metadataId: md._id,
    originalName: md.originalName,
    uploadedAt: ClockService.now(),
    uploadedBy: userId,
  }));

  return { documentsPayload, createdMetadata };
}

/**
 * resolve Policy Term Schedule
 *
 * Performs logic operations for resolvePolicyTermSchedule.
 *
 * @param property - Request/input argument
 * @param data - Request/input argument
 * @returns Operations result
 */
function resolvePolicyTermSchedule(property, data) {
  const propertyName = property.name;
  const unitLabel = resolveInvoiceUnitLabel(property, data.unit);

  const rp = property.requestPayload && typeof property.requestPayload === 'object' && !Array.isArray(property.requestPayload)
    ? property.requestPayload
    : {};
  const dueDaySetting = resolvePaymentDueDayFromSources({ requestPayload: rp });

  let firstMonthlyDue = null;
  if (data.dueDate) {
    const rawDue = DateUtil.toUTC(data.dueDate);
    if (rawDue) {
      const dueKey = DateUtil.toEST(rawDue);
      firstMonthlyDue = dueKey ? DateUtil.parseDateOnlyToNoonUtc(dueKey) : null;
    }
  }

  if (!firstMonthlyDue) {
    let dateParts = null;
    if (property.balanceAsOf) {
      const raw = property.balanceAsOf;
      const ymd = raw instanceof Date && !Number.isNaN(raw.getTime())
        ? raw.toISOString().split('T')[0]
        : raw;
      dateParts = parseDateOnlyToUtcParts(ymd);
    }
    if (!dateParts) {
      throw new Error(
        'Cannot schedule policy invoices: select a due date for the first invoice, or set balance as of date on the unit.'
      );
    }
    firstMonthlyDue = firstMonthlyDueDateUtc(dateParts, dueDaySetting);
  }

  return { propertyName, unitLabel, firstMonthlyDue, dueDaySetting };
}

/**
 * build Policy Term Invoice Documents
 *
 * Performs logic operations for buildPolicyTermInvoiceDocuments.
 *
 * @returns Operations result
 */
function buildPolicyTermInvoiceDocuments({
  data,
  property,
  policyMonths,
  invoiceIds,
  documentsPayload,
  userId,
  firstMonthlyDue,
  fee,
  prepaidPool: initialPrepaidPool,
}) {
  const today = ClockService.now();

  let prepaidPool = roundCurrency(initialPrepaidPool || 0);
  const invoiceDocs = [];

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  for (let i = 0; i < policyMonths; i++) {
    const dueDate = addUtcCalendarMonths(firstMonthlyDue, i);
    const isDue = isDueDateOnOrBeforeToday(dueDate, today);

    let appliedPrepaid = 0;
    let balanceDue = fee;
    let status = INVOICE_STATUS.PENDING;
    let paidOn;
    let noteExtra = '';

    if (isDue && prepaidPool > 0) {
      appliedPrepaid = roundCurrency(Math.min(fee, prepaidPool));
      prepaidPool = roundCurrency(prepaidPool - appliedPrepaid);
      balanceDue = roundCurrency(fee - appliedPrepaid);
      if (balanceDue === 0) {
        status = INVOICE_STATUS.PAID;
        paidOn = ClockService.now();
      } else {
        status = INVOICE_STATUS.PARTIALLY_PAID;
      }
      noteExtra = appliedPrepaid > 0 ? `Prepaid applied: $${appliedPrepaid.toFixed(2)}` : '';
    }

    const combinedNotes = [data.notes, noteExtra].filter(Boolean).join(' | ');
    const attachmentIds = documentsPayload.map((d) => d.metadataId).filter(Boolean);
    const creationComments = [];
    if (combinedNotes || attachmentIds.length > 0) {
      const actorId = userId || data.createdBy;
      const now = ClockService.now();
      creationComments.push({
        text: combinedNotes || 'Invoice created.',
        title: 'Invoice created',
        isPinned: false,
        isImportant: false,
        isSystem: false,
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
        attachments: attachmentIds,
      });
    }
    const term = `${MONTH_NAMES[dueDate.getUTCMonth()]} ${dueDate.getUTCFullYear()}`;

    const creditPaymentTx =
      appliedPrepaid > 0
        ? buildCreditAppliedPaymentTransaction({
            amount: appliedPrepaid,
            balanceAfter: balanceDue,
            paidAt: paidOn || ClockService.now(),
            source: 'prepaid_pool',
          })
        : null;

    invoiceDocs.push({
      invoiceId: invoiceIds[i],
      type: data.type,
      status,
      propertyId: data.propertyId,
      hoaId: property.hoaId || data.hoaId || undefined,
      propertyName: property.name,
      unit: resolveInvoiceUnitLabel(property, data.unit),
      term,
      tenants: data.tenants,
      isAllTenantSelected: data.isAllTenantSelected,
      invoiceItemDetails: data.invoiceItemDetails,
      subAmount: fee,
      principalSubAmount: fee,
      alreadyPaid: appliedPrepaid,
      balanceDue,
      isPartialPaymentAllowed: data.isPartialPaymentAllowed,
      dueDate,
      isRecurringInvoice: false,
      generatedFrom: 'policy_term',
      createdBy: userId || data.createdBy,
      ...(documentsPayload.length > 0 ? { documents: documentsPayload } : {}),
      ...(creationComments.length > 0 ? { comments: creationComments } : {}),
      ...(paidOn ? { paidOn } : {}),
      ...(creditPaymentTx ? { paymentTransactions: [creditPaymentTx] } : {}),
    });
  }

  return invoiceDocs;
}

async function insertPolicyTermInvoicesInBatches(invoiceDocs, options = {}) {
  const {
    session,
    batchSize = POLICY_TERM_INSERT_BATCH_SIZE,
    onProgress,
  } = options;

  if (!invoiceDocs.length) return [];

  const insertOpts = session ? { session, ordered: true } : { ordered: true };
  const effectiveBatchSize = batchSize > 0 ? batchSize : invoiceDocs.length;

  if (invoiceDocs.length <= effectiveBatchSize) {
    const saved = await Invoice.insertMany(invoiceDocs, insertOpts);
    if (onProgress) onProgress(invoiceDocs.length, invoiceDocs.length);
    return saved;
  }

  const allSaved = [];
  for (let i = 0; i < invoiceDocs.length; i += effectiveBatchSize) {
    const batch = invoiceDocs.slice(i, i + effectiveBatchSize);
    const saved = await Invoice.insertMany(batch, insertOpts);
    allSaved.push(...saved);
    if (onProgress) {
      onProgress(Math.min(i + batch.length, invoiceDocs.length), invoiceDocs.length);
    }
  }

  return allSaved;
}

async function cleanupUploadedMetadata(createdMetadata) {
  try {
    for (const md of createdMetadata) {
      if (md && md.key) await s3Client.delete({ key: md.key });
    }
  } catch (cleanupErr) {
    logger.error('Failed to cleanup uploaded files after policy invoice create failure:', cleanupErr);
  }
}

/**
 * Create N monthly fee invoices from one create request (policy term months).
 * @param {Object} data
 * @param {string} userId
 * @param {Array} files
 * @param {number} policyMonths
 * @param {{ onProgress?: (processed: number, total: number) => void, documentsPayload?: Array, skipFileUpload?: boolean }} [options]
 */
async function executePolicyTermInvoiceCreate(data, userId, files, policyMonths, options = {}) {
  const property = await Property.findById(data.propertyId).lean();
  if (!property) {
    throw new Error('Property not found');
  }

  const { propertyName, unitLabel, firstMonthlyDue } = resolvePolicyTermSchedule(property, data);
  const fee = roundCurrency(data.subAmount);
  const prepaidPool = roundCurrency(data.alreadyPaid || 0);

  const session = await mongoose.startSession();
  session.startTransaction();
  let transactionCommitted = false;
  let createdMetadata = [];

  try {
    let documentsPayload = options.documentsPayload || [];
    if (!options.skipFileUpload && files && files.length > 0) {
      const prepared = await preparePolicyTermDocumentsPayload(files, userId, session);
      documentsPayload = prepared.documentsPayload;
      createdMetadata = prepared.createdMetadata;
    }

    const invoiceIds = await allocateUniqueInvoiceIds(policyMonths, { session });
    const invoiceDocs = buildPolicyTermInvoiceDocuments({
      data,
      property,
      policyMonths,
      invoiceIds,
      documentsPayload,
      userId,
      firstMonthlyDue,
      fee,
      prepaidPool,
    });

    const savedInvoices = await insertPolicyTermInvoicesInBatches(invoiceDocs, {
      session,
      onProgress: options.onProgress,
    });

    await session.commitTransaction();
    transactionCommitted = true;
    session.endSession();

    let resultInvoices = savedInvoices;
    let creditModified = false;
    if (data.propertyId) {
      const safePropertyId = toObjectId(data.propertyId);
      if (safePropertyId) {
        const creditResult = await ledgerService.applyAllUnappliedCreditToDueInvoices(safePropertyId);
        creditModified = Boolean(creditResult && creditResult.modified);
        if (creditModified) {
          const ids = toObjectIdArray(savedInvoices.map((x) => x._id));
          resultInvoices = await Invoice.find({ _id: { $in: ids } }).sort({ dueDate: 1 });
        }
      }
    }

    await logActivity({
      userId,
      action: 'CREATE',
      module: 'Invoice',
      entityId: savedInvoices[0]._id,
      entityName: 'HOA Invoice (policy schedule)',
      description: `Created ${policyMonths} monthly HOA fee invoices for ${propertyName} (${unitLabel}) - $${fee}/mo`,
      meta: { type: data.type, count: policyMonths, propertyName },
    });

    return {
      bulkPolicyInvoices: true,
      invoiceCount: resultInvoices.length,
      invoices: resultInvoices,
      creditModified,
    };
  } catch (err) {
    if (!transactionCommitted) {
      try { await session.abortTransaction(); } catch (e) { /* ignore */ }
    }
    session.endSession();
    await cleanupUploadedMetadata(createdMetadata);
    throw err;
  }
}

module.exports = {
  executePolicyTermInvoiceCreate,
  buildPolicyTermInvoiceDocuments,
  insertPolicyTermInvoicesInBatches,
  preparePolicyTermDocumentsPayload,
  resolvePolicyTermSchedule,
  cleanupUploadedMetadata,
};
