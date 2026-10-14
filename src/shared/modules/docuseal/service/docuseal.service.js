const jwt = require('jsonwebtoken');
const { getDocusealConfig } = require('../../../../config/docuseal.config');
const {
  docusealTemplatePathForUpload,
  stripEsignUploadExtension,
} = require('../utils/esignUploadTypes');

class DocusealConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocusealConfigError';
    this.statusCode = 503;
  }
}

function requireConfig() {
  const config = getDocusealConfig();
  if (!config.configured) {
    throw new DocusealConfigError(
      'DocuSeal is not configured. Set DOCUSEAL_API_KEY and DOCUSEAL_USER_EMAIL in the backend env.'
    );
  }
  return config;
}

async function docusealFetch(path, options = {}) {
  const config = requireConfig();
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': config.apiKey,
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || `DocuSeal API error (${response.status})`;
    const err = new Error(message);
    err.statusCode = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw err;
  }
  return data;
}

function getStatus() {
  const config = getDocusealConfig();
  return {
    configured: config.configured,
    apiUrl: config.apiUrl,
    userEmail: config.configured ? config.userEmail : null,
    modeHint: config.modeHint,
    defaultSignerEmail: config.defaultSignerEmail || null,
    defaultSigningSrc: config.defaultSigningSrc || null,
  };
}

function createBuilderToken(body = {}) {
  const config = requireConfig();
  const {
    integration_email = 'signer@example.com',
    name = 'Integration W-9 Test Form',
    template_id,
    external_id = 'TestForm123',
  } = body;

  const payload = {
    user_email: config.userEmail,
    integration_email,
    external_id,
    name,
  };

  if (template_id) {
    payload.template_id = Number(template_id);
  } else if (Object.prototype.hasOwnProperty.call(body, 'document_urls')) {
    // Explicit empty array opens DocuSeal upload-ready builder
    payload.document_urls = Array.isArray(body.document_urls) ? body.document_urls : [body.document_urls];
  } else {
    payload.document_urls = ['https://www.irs.gov/pub/irs-pdf/fw9.pdf'];
  }

  const token = jwt.sign(payload, config.apiKey);
  return {
    token,
    payload,
    keyPreview: `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-4)}`,
  };
}

function createSigningToken(body = {}) {
  const config = requireConfig();
  const {
    slug,
    email = config.defaultSignerEmail,
    external_id,
    preview = false,
  } = body;

  if (!slug) {
    const err = new Error('slug is required (template or submitter slug)');
    err.statusCode = 400;
    throw err;
  }

  const payload = { slug, preview };
  if (email) payload.email = email;
  if (external_id) payload.external_id = external_id;

  const token = jwt.sign(payload, config.apiKey);
  return { token, payload };
}

function listTemplates() {
  return docusealFetch('/templates');
}

function getTemplate(id) {
  return docusealFetch(`/templates/${id}`);
}

/**
 * Create a DocuSeal template from an uploaded document (PDF, DOCX, XLSX, JPEG, PNG, ZIP).
 * DOCX uses POST /templates/docx; other supported types use POST /templates/pdf.
 */
async function createTemplateFromUpload({
  name,
  fileBase64,
  fileName = 'document.pdf',
  mimeType = '',
  externalId,
}) {
  if (!fileBase64) {
    const err = new Error('Document file content is required');
    err.statusCode = 400;
    throw err;
  }

  const documentName = stripEsignUploadExtension(fileName);
  const body = {
    name: name || documentName,
    documents: [
      {
        name: documentName,
        file: fileBase64,
      },
    ],
  };

  if (externalId) {
    body.external_id = externalId;
  }

  return docusealFetch(docusealTemplatePathForUpload(fileName, mimeType), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function createTemplateFromPdf(params) {
  return createTemplateFromUpload(params);
}

function getSubmission(id) {
  if (id == null || id === '') {
    const err = new Error('submission id is required');
    err.statusCode = 400;
    throw err;
  }
  return docusealFetch(`/submissions/${id}`);
}

function getSubmissionDocuments(id, { merge = false } = {}) {
  const q = merge ? '?merge=true' : '';
  return docusealFetch(`/submissions/${id}/documents${q}`);
}

function updateSubmitter(id, body = {}) {
  if (id == null || id === '') {
    const err = new Error('submitter id is required');
    err.statusCode = 400;
    throw err;
  }
  return docusealFetch(`/submitters/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function resendSubmitterEmail(id) {
  return updateSubmitter(id, { send_email: true });
}

function listSubmissions() {
  return docusealFetch('/submissions');
}

function createSubmission(body = {}) {
  const config = requireConfig();
  const {
    template_id,
    submitters = [{ email: config.defaultSignerEmail || 'signer@example.com' }],
    send_email = true,
  } = body;

  if (!template_id) {
    const err = new Error('template_id is required');
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(submitters) || submitters.length === 0) {
    const err = new Error('At least one submitter email is required');
    err.statusCode = 400;
    throw err;
  }

  return docusealFetch('/submissions', {
    method: 'POST',
    body: JSON.stringify({ template_id, submitters, send_email }),
  });
}

/**
 * Create DocuSeal submission + local tracking record in one step.
 */
async function sendForSignature({ user, authUser, body = {} }) {
  const esignTrackingService = require('./esignTracking.service');
  const templateId = Number(body.template_id || body.templateId);
  const documentName = body.documentName || body.name || `Document ${templateId}`;
  const rawSubmitters = Array.isArray(body.submitters) ? body.submitters : [];

  const submitters = rawSubmitters
    .map((s) => ({
      email: String(s.email || '').trim().toLowerCase(),
      name: s.name ? String(s.name).trim() : undefined,
      role: s.role ? String(s.role).trim() : undefined,
    }))
    .filter((s) => s.email);

  if (!templateId) {
    const err = new Error('template_id is required');
    err.statusCode = 400;
    throw err;
  }
  if (!submitters.length) {
    const err = new Error('At least one signer email is required');
    err.statusCode = 400;
    throw err;
  }

  // Ensure every submitter has a role - DocuSeal requires role matching template parties
  const withRoles = submitters.map((s, index) => ({
    email: s.email,
    ...(s.name ? { name: s.name } : {}),
    role: s.role || (index === 0 ? 'First Party' : `Party ${index + 1}`),
  }));

  const created = await createSubmission({
    template_id: templateId,
    submitters: withRoles,
    send_email: body.send_email !== false,
  });

  // DocuSeal may return an array of submitters or a submission object
  const createdSubmitters = Array.isArray(created)
    ? created
    : Array.isArray(created?.submitters)
      ? created.submitters
      : [];

  const submissionId =
    Number(created?.id) ||
    Number(createdSubmitters[0]?.submission_id) ||
    null;

  let sendPayload = created;
  if (submissionId) {
    try {
      const full = await getSubmission(submissionId);
      sendPayload = {
        ...full,
        template: full.template || {
          id: templateId,
          name: documentName,
          external_id: null,
          created_at: full.created_at,
        },
      };
    } catch {
      sendPayload = {
        id: submissionId,
        status: 'pending',
        template: { id: templateId, name: documentName, external_id: null, created_at: new Date().toISOString() },
        submitters: createdSubmitters,
        template_submitters: withRoles.map((s, i) => ({
          name: s.role,
          uuid: createdSubmitters[i]?.uuid || `role-${i}`,
          email: s.email,
        })),
      };
    }
  } else if (createdSubmitters.length) {
    sendPayload = {
      id: Number(createdSubmitters[0].submission_id),
      status: 'pending',
      template: { id: templateId, name: documentName, external_id: null, created_at: new Date().toISOString() },
      submitters: createdSubmitters,
      template_submitters: withRoles.map((s, i) => ({
        name: s.role,
        uuid: createdSubmitters[i]?.uuid || `role-${i}`,
        email: s.email,
      })),
    };
  }

  const record = await esignTrackingService.createFromSendPayload({
    user,
    authUser,
    body: {
      sendPayload,
      documentName,
      portal: body.portal,
      hoaId: body.hoaId,
      source: body.source || 'api-send',
      templateId,
    },
  });

  return {
    record,
    submission: sendPayload,
    submitters: createdSubmitters,
  };
}

module.exports = {
  DocusealConfigError,
  getStatus,
  createBuilderToken,
  createSigningToken,
  listTemplates,
  getTemplate,
  createTemplateFromPdf,
  createTemplateFromUpload,
  getSubmission,
  getSubmissionDocuments,
  listSubmissions,
  createSubmission,
  updateSubmitter,
  resendSubmitterEmail,
  sendForSignature,
};
