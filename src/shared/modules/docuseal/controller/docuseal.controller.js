const logger = require('../../../../common/logger');
const { success, error } = require('../../../../common/helpers/responseHelper');
const docusealService = require('../service/docuseal.service');
const esignTrackingService = require('../service/esignTracking.service');
const {
  ESIGN_UPLOAD_LABEL,
  isAllowedEsignUpload,
  stripEsignUploadExtension,
} = require('../utils/esignUploadTypes');

function handleError(res, err, action) {
  const statusCode = err.statusCode || 500;
  logger.error(`[DocuSeal] ${action} failed:`, err.message);
  return error(res, err.message || `Failed to ${action}`, statusCode);
}

function resolveSigningRecordAuth(req) {
  const hoaContextId = req.hoaContext?.hoaId || null;
  const requestedHoaId = req.query.hoaId || req.headers['x-hoa-id'] || null;
  const portal = String(req.query.portal || req.body?.portal || '').toLowerCase();
  const useHoaScope = Boolean(hoaContextId) || portal === 'hoa';
  return {
    userId: req.userId || req.user?._id || req.user?.id,
    companyId: req.authUser?.companyId || req.query.companyId || null,
    hoaId: useHoaScope ? (hoaContextId || requestedHoaId) : null,
  };
}

async function getStatus(req, res) {
  try {
    return success(res, docusealService.getStatus(), 'DocuSeal status');
  } catch (err) {
    return handleError(res, err, 'get status');
  }
}

async function createBuilderToken(req, res) {
  try {
    const data = docusealService.createBuilderToken(req.body || {});
    return success(res, data, 'Builder token created');
  } catch (err) {
    return handleError(res, err, 'create builder token');
  }
}

async function createSigningToken(req, res) {
  try {
    const data = docusealService.createSigningToken(req.body || {});
    return success(res, data, 'Signing token created');
  } catch (err) {
    return handleError(res, err, 'create signing token');
  }
}

async function listTemplates(req, res) {
  try {
    const data = await docusealService.listTemplates();
    return success(res, data, 'Templates loaded');
  } catch (err) {
    return handleError(res, err, 'list templates');
  }
}

async function getTemplate(req, res) {
  try {
    const data = await docusealService.getTemplate(req.params.id);
    return success(res, data, 'Template loaded');
  } catch (err) {
    return handleError(res, err, 'get template');
  }
}

async function createTemplateFromUpload(req, res) {
  try {
    if (!req.file?.buffer) {
      return error(res, 'Document file is required (field name: file)', 400);
    }

    const mime = req.file.mimetype || '';
    const original = req.file.originalname || 'document.pdf';
    if (!isAllowedEsignUpload(original, mime)) {
      return error(res, `Only ${ESIGN_UPLOAD_LABEL} files are supported`, 400);
    }

    const fileBase64 = req.file.buffer.toString('base64');
    const name = (req.body?.name || stripEsignUploadExtension(original)).trim();

    const data = await docusealService.createTemplateFromUpload({
      name,
      fileBase64,
      fileName: original,
      mimeType: mime,
      externalId: req.body?.external_id || `esign-upload-${Date.now()}`,
    });

    return success(
      res,
      {
        id: data.id,
        name: data.name || name,
        slug: data.slug,
        template: data,
      },
      'Template created from uploaded document',
      201
    );
  } catch (err) {
    return handleError(res, err, 'create template from upload');
  }
}

function createTemplateFromPdf(req, res) {
  return createTemplateFromUpload(req, res);
}

async function listSubmissions(req, res) {
  try {
    const data = await docusealService.listSubmissions();
    return success(res, data, 'Submissions loaded');
  } catch (err) {
    return handleError(res, err, 'list submissions');
  }
}

async function createSubmission(req, res) {
  try {
    const data = await docusealService.createSubmission(req.body || {});
    return success(res, data, 'Submission created', 201);
  } catch (err) {
    return handleError(res, err, 'create submission');
  }
}

/** Create DocuSeal submission + local signing record (PropMv Send dialog) */
async function sendForSignature(req, res) {
  try {
    const auth = resolveSigningRecordAuth(req);
    const data = await docusealService.sendForSignature({
      user: req.user,
      authUser: req.authUser,
      body: {
        ...(req.body || {}),
        portal: req.body?.portal || (auth.hoaId ? 'hoa' : req.body?.portal),
        hoaId: req.body?.hoaId || auth.hoaId,
      },
    });
    return success(res, data, 'Document sent for signature', 201);
  } catch (err) {
    return handleError(res, err, 'send for signature');
  }
}

async function getSubmission(req, res) {
  try {
    const data = await docusealService.getSubmission(req.params.id);
    return success(res, data, 'Submission loaded');
  } catch (err) {
    return handleError(res, err, 'get submission');
  }
}

/** Persist local signing record after builder Send */
async function createSigningRecord(req, res) {
  try {
    const auth = resolveSigningRecordAuth(req);
    const data = await esignTrackingService.createFromSendPayload({
      user: req.user,
      authUser: req.authUser,
      body: {
        ...(req.body || {}),
        portal: req.body?.portal || (auth.hoaId ? 'hoa' : req.body?.portal),
        hoaId: req.body?.hoaId || auth.hoaId,
      },
    });
    return success(res, data, 'Signing record created', 201);
  } catch (err) {
    return handleError(res, err, 'create signing record');
  }
}

async function listSigningRecords(req, res) {
  try {
    const auth = resolveSigningRecordAuth(req);
    const data = await esignTrackingService.listRecords({
      userId: auth.userId,
      companyId: auth.hoaId ? null : auth.companyId,
      hoaId: auth.hoaId,
      status: req.query.status || null,
      limit: req.query.limit,
      skip: req.query.skip,
    });
    return success(res, data, 'Signing records loaded');
  } catch (err) {
    return handleError(res, err, 'list signing records');
  }
}

async function getSigningRecord(req, res) {
  try {
    const data = await esignTrackingService.getRecordById(
      req.params.id,
      resolveSigningRecordAuth(req)
    );
    return success(res, data, 'Signing record loaded');
  } catch (err) {
    return handleError(res, err, 'get signing record');
  }
}

async function refreshSigningRecord(req, res) {
  try {
    const data = await esignTrackingService.refreshRecordById(
      req.params.id,
      resolveSigningRecordAuth(req)
    );
    return success(res, data, 'Signing record refreshed');
  } catch (err) {
    return handleError(res, err, 'refresh signing record');
  }
}

async function resendSigningInvite(req, res) {
  try {
    const data = await esignTrackingService.resendInvite(
      req.params.id,
      { email: req.body?.email },
      resolveSigningRecordAuth(req)
    );
    return success(res, data, 'Signing invitation resent');
  } catch (err) {
    return handleError(res, err, 'resend signing invitation');
  }
}

/** Public DocuSeal webhook receiver */
async function handleWebhook(req, res) {
  try {
    const result = await esignTrackingService.handleWebhookEvent(req.body || {});
    return success(res, result, 'Webhook processed');
  } catch (err) {
    return handleError(res, err, 'process webhook');
  }
}

module.exports = {
  getStatus,
  createBuilderToken,
  createSigningToken,
  listTemplates,
  getTemplate,
  createTemplateFromPdf,
  createTemplateFromUpload,
  listSubmissions,
  createSubmission,
  sendForSignature,
  getSubmission,
  createSigningRecord,
  listSigningRecords,
  getSigningRecord,
  refreshSigningRecord,
  resendSigningInvite,
  handleWebhook,
};
