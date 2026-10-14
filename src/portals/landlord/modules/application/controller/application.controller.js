/**
 * ------------------------------------------------------------------
 * File: application.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * application.routes
 * ------------------------------------------------------------------
 */

const applicationService = require('../service/application.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const { resolveCreatedBy } = require('../../../../../shared/utils/creatorScope.util');
const { wrapController } = require('../../../../../common/helpers/asyncHandler');

/**
 * resolve Actor Id
 *
 * Performs logic operations for resolveActorId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function resolveActorId(req) {
  return req.user && (req.user._id || req.user.id);
}

const createApplication = async (req, res) => {
  const actorId = resolveActorId(req);
  const body = Object.assign({}, req.body || {}, {
    createdBy: resolveCreatedBy(req.body || {}, actorId),
  });
  const created = await applicationService.createApplication(body);
  return responseHelper.success(res, { application: created }, 'Application created', 201);
};

const updateApplication = async (req, res) => {
  const id = req.params && req.params.id;
  const updated = await applicationService.updateApplication(id, req.body || {});
  const actorId = resolveActorId(req);
  return responseHelper.success(res, { application: updated }, 'Application updated', 200);
};

const getApplicationById = async (req, res) => {
  const id = req.params && req.params.id;
  const app = await applicationService.getApplicationById(id);
  return responseHelper.success(res, { application: app }, 'Application fetched', 200);
};

const getLeaseScreeningSummary = async (req, res) => {
  const id = req.params && req.params.id;
  const summary = await applicationService.getLeaseScreeningSummary(id);
  return responseHelper.success(res, summary, 'Lease screening summary fetched', 200);
};

const getApplicantNames = async (req, res) => {
  const { text } = req.query;
  const actorId = resolveActorId(req);
  const createdBy = resolveCreatedBy(req.query || {}, actorId);
  const names = await applicationService.getApplicantNames(text, createdBy);
  return responseHelper.success(res, { applicants: names }, 'Applicant names fetched', 200);
};

const listApplications = async (req, res) => {
  const actorId = resolveActorId(req);
  const q = Object.assign({}, req.query || {}, {
    createdBy: resolveCreatedBy(req.query || {}, actorId),
  });
  const result = await applicationService.listApplications(q);
  return responseHelper.success(res, result, 'Applications fetched', 200);
};

const deleteApplication = async (req, res) => {
  const id = req.params && req.params.id;
  await applicationService.deleteApplication(id);
  return responseHelper.success(res, null, 'Application deleted', 200);
};

const approveApplication = async (req, res) => {
  const id = req.params && req.params.id;
  const { comment } = req.body || {};
  const actorId = resolveActorId(req);
  const updated = await applicationService.approveApplication(id, comment, actorId);
  return responseHelper.success(res, { application: updated }, 'Application approved', 200);
};

const rejectApplication = async (req, res) => {
  const id = req.params && req.params.id;
  const { rejectionReason, comment } = req.body || {};
  const actorId = resolveActorId(req);
  const actionComment = comment || rejectionReason || '';
  const updated = await applicationService.rejectApplication(id, rejectionReason, actionComment, actorId);
  return responseHelper.success(res, { application: updated }, 'Application rejected', 200);
};

const updateScreeningInfo = async (req, res) => {
  const id = req.params && req.params.id;
  const updated = await applicationService.updateScreeningInfo(id, req.body || {});
  const actorId = resolveActorId(req);
  return responseHelper.success(res, { application: updated }, 'Screening info updated', 200);
};

const addNote = async (req, res) => {
  const id = req.params && req.params.id;
  const { text } = req.body || {};
  const userId = resolveActorId(req);
  const updated = await applicationService.addComment(id, text, userId, 'note');
  return responseHelper.success(res, { application: updated }, 'Comment added', 200);
};

const exportApplications = async (req, res) => {
  const actorId = resolveActorId(req);
  const q = Object.assign({}, req.query || {}, {
    createdBy: resolveCreatedBy(req.query || {}, actorId),
  });
  const format = q.format || 'csv';
  delete q.format;

  const result = await applicationService.exportApplications(q, format);
  const filename = result && result.filename ? result.filename : `applications_export.${format}`;
  const content = result && result.content ? result.content : '';
  const contentType = result && result.contentType ? result.contentType : 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(content);
};

const createBlankApplicationForTenant = async (req, res) => {
  const { tenantId, leaseId } = req.body || {};
  const created = await applicationService.createBlankApplicationForTenant(tenantId, null, leaseId);
  return responseHelper.success(res, { application: created }, 'Blank application created successfully', 201);
};

const acknowledgeLeaseInvitePublic = async (req, res) => {
  const { leaseId, tenantId } = req.body || {};
  const result = await applicationService.acknowledgeLeaseInvitePublic({ leaseId, tenantId });
  return responseHelper.success(res, result, 'Lease invite acknowledged', 200);
};

const submitScreeningApplication = async (req, res) => {
  const { leaseId, tenantId } = req.params || {};
  const created = await applicationService.submitScreeningApplication(leaseId, tenantId, req.body || {});
  const createdBy = resolveCreatedBy(req.body || {});
  return responseHelper.success(res, { application: created }, 'Application submitted successfully', 201);
};

const shareApplicationViaEmail = async (req, res) => {
  const applicationId = req.params.id;
  const { screeningOptions, email } = req.body || {};
  const actorId = resolveActorId(req);

  await applicationService.shareApplicationViaEmail(applicationId, { screeningOptions, email });

  return responseHelper.success(
    res,
    { shared: true, email },
    'Application shared via email successfully',
    200
  );
};

const shareApplicationViaUrl = async (req, res) => {
  const applicationId = req.params.id;
  const { screeningSettings } = req.body || {};
  const actorId = resolveActorId(req);

  const { shareToken, shareUrl } = await applicationService.shareApplicationViaUrl(
    applicationId,
    { screeningSettings }
  );

  return responseHelper.success(
    res,
    { shared: true, shareToken, shareUrl },
    'Application share URL generated successfully',
    200
  );
};

const requestApplication = async (req, res) => {
  const { email, screening = [], propertyName = 'Property' } = req.body || {};
  const actorId = resolveActorId(req);

  const result = await applicationService.sendApplicationRequestEmail({
    email,
    screening,
    propertyName,
    createdBy: actorId,
  });

  return responseHelper.success(
    res,
    result,
    'Application request email sent successfully',
    201
  );
};

module.exports = wrapController({
  createApplication,
  updateApplication,
  getApplicationById,
  getLeaseScreeningSummary,
  listApplications,
  deleteApplication,
  approveApplication,
  rejectApplication,
  updateScreeningInfo,
  getApplicantNames,
  addNote,
  exportApplications,
  createBlankApplicationForTenant,
  submitScreeningApplication,
  acknowledgeLeaseInvitePublic,
  shareApplicationViaEmail,
  shareApplicationViaUrl,
  requestApplication,
});
