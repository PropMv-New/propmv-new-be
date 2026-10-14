/**
 * ------------------------------------------------------------------
 * File: documents.controller.js
 * Module: Documents Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * documents.routes
 * ------------------------------------------------------------------
 */

const service = require('../service/documents.service');
const hoaService = require('../service/hoa.service');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');
const { getRequestRole, resolveDocumentHoaContext } = require('../helpers/hoaDocumentContext');
const { sendBinaryDownload } = require('../../../../common/helpers/fileDownloadHelper');

const getMetadata = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getMetadata' });
  try {
    try {
      const metadata = await service.getDocumentMetadata(req.params.id);
      // Prefer a short-lived signed URL so private buckets still render in <img>/preview UIs
      let url = null;
      try {
        url = await service.getPresignedUrl(req.params.id, 3600);
      } catch (_) {
        url = service.buildPublicUrl(metadata);
      }
      return res.status(200).json(Object.assign({}, metadata, { url }));
    } catch (metadataErr) {
      const tryHoa =
        metadataErr.status === 404 ||
        metadataErr.name === 'CastError' ||
        (metadataErr.message && String(metadataErr.message).includes('Cast to ObjectId'));
      if (!tryHoa) throw metadataErr;

      const role = await getRequestRole(req);
      const hoaContext = await resolveDocumentHoaContext(req);
      const document = await hoaService.getHOADocumentById(req.params.id, role, hoaContext, {
        userId: req.user?.id || req.user?._id || req.userId || null,
        email: req.user?.email,
      });
      return res.status(200).json(document);
    }
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const getPresignedUrl = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getPresignedUrl' });
  try {
    const expiresIn = parseInt(req.query.expiresIn) || 3600;
    const url = await service.getPresignedUrl(req.params.id, expiresIn);
    return res.status(200).json({ url, expiresIn });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const download = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'download' });
  try {
    const id = req.params.id;
    const role = await getRequestRole(req);
    const hoaContext = await resolveDocumentHoaContext(req);
    let stream;
    let fileName;
    let contentType;

    try {
      const result = await hoaService.getHOADocumentStream(id, role, hoaContext, {
        userId: req.user?.id || req.user?._id || req.userId || null,
        email: req.user?.email,
      });
      stream = result.stream;
      fileName = result.fileName;
      contentType = result.contentType;
    } catch (hoaErr) {
      const tryRegular =
        hoaErr.status === 404 ||
        hoaErr.name === 'CastError' ||
        (hoaErr.message && String(hoaErr.message).includes('Cast to ObjectId'));
      if (!tryRegular) throw hoaErr;
      const HOADocument = require('../model/hoaDocument.model');
      const isHoaDoc = await HOADocument.exists({ _id: id });
      if (isHoaDoc) throw hoaErr;
      const result = await service.getDocumentStream(id);
      stream = result.stream;
      fileName = result.fileName;
      contentType = result.contentType;
    }

    return await sendBinaryDownload(res, { stream, fileName, contentType });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const remove = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'remove' });
  try {
    await service.deleteDocument(req.params.id, { userId: req.userId });
    return res.status(200).json({ message: 'Document deleted' });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

module.exports = {
  getMetadata,
  getPresignedUrl,
  download,
  remove
};
