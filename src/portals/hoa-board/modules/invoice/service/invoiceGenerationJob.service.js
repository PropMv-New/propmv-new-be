/**
 * ------------------------------------------------------------------
 * File: invoiceGenerationJob.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.service
 * ------------------------------------------------------------------
 */

const { v4: uuidv4 } = require('uuid');
const InvoiceGenerationJob = require('../model/invoiceGenerationJob.model');
const policyTermService = require('./invoicePolicyTerm.service');
const { ClockService, DateUtil } = require('../../../../../common/date');

async function startPolicyTermJob(data, userId, files, policyMonths) {
  let documentsPayload = [];
  let createdMetadata = [];

  if (files && files.length > 0) {
    const prepared = await policyTermService.preparePolicyTermDocumentsPayload(files, userId, null);
    documentsPayload = prepared.documentsPayload;
    createdMetadata = prepared.createdMetadata;
  }

  const jobId = `invoice_gen_${uuidv4()}`;
  const job = await InvoiceGenerationJob.create({
    jobId,
    userId,
    hoaId: data.hoaId || undefined,
    status: 'pending',
    totalInvoices: policyMonths,
    processedInvoices: 0,
    payload: data,
    documentsPayload: documentsPayload.length > 0 ? documentsPayload : null,
  });

  setImmediate(() => processPolicyTermJob(job.jobId, createdMetadata));

  return {
    asyncJob: true,
    jobId: job.jobId,
    status: 'processing',
    totalInvoices: policyMonths,
    message: `Generating ${policyMonths} invoices in the background. Poll /hoa/invoice/generation/${job.jobId}/status for progress.`,
  };
}

async function processPolicyTermJob(jobId, createdMetadata = []) {
  const job = await InvoiceGenerationJob.findOne({ jobId });
  if (!job) return;

  try {
    job.status = 'processing';
    await job.save();

    const policyMonths = job.totalInvoices;
    const result = await policyTermService.executePolicyTermInvoiceCreate(
      job.payload,
      job.userId,
      null,
      policyMonths,
      {
        documentsPayload: job.documentsPayload || [],
        skipFileUpload: true,
        onProgress: async (processed, total) => {
          await InvoiceGenerationJob.updateOne(
            { jobId },
            { $set: { processedInvoices: processed, totalInvoices: total } }
          );
        },
      }
    );

    await InvoiceGenerationJob.updateOne(
      { jobId },
      {
        $set: {
          status: 'completed',
          processedInvoices: policyMonths,
          invoiceCount: result.invoiceCount,
          resultInvoiceIds: (result.invoices || []).map((inv) => inv._id),
          completedAt: ClockService.now(),
        },
      }
    );
  } catch (err) {
    await policyTermService.cleanupUploadedMetadata(createdMetadata);
    await InvoiceGenerationJob.updateOne(
      { jobId },
      {
        $set: {
          status: 'failed',
          errorMessage: err.message || 'Invoice generation failed',
          completedAt: ClockService.now(),
        },
      }
    );
  }
}

async function getPolicyTermJobStatus(jobId, userId) {
  const job = await InvoiceGenerationJob.findOne({ jobId }).lean();
  if (!job) {
    const err = new Error('Invoice generation job not found');
    err.status = 404;
    throw err;
  }

  if (userId && String(job.userId) !== String(userId)) {
    const err = new Error('Invoice generation job not found');
    err.status = 404;
    throw err;
  }

  const progressPercent = job.totalInvoices > 0
    ? Math.min(100, Math.round((job.processedInvoices / job.totalInvoices) * 100))
    : 0;

  return {
    jobId: job.jobId,
    status: job.status,
    totalInvoices: job.totalInvoices,
    processedInvoices: job.processedInvoices,
    invoiceCount: job.invoiceCount,
    progressPercent,
    errorMessage: job.errorMessage || undefined,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    bulkPolicyInvoices: job.status === 'completed',
  };
}

module.exports = {
  startPolicyTermJob,
  processPolicyTermJob,
  getPolicyTermJobStatus,
};
