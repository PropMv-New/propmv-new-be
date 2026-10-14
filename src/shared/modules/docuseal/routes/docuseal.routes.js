const express = require('express');
const multer = require('multer');
const router = express.Router();

const authMiddleware = require('../../../../middleware/auth');
const docusealController = require('../controller/docuseal.controller');
const {
  ESIGN_UPLOAD_LABEL,
  ESIGN_UPLOAD_MAX_BYTES,
  ESIGN_UPLOAD_SIZE_LABEL,
  isAllowedEsignUpload,
} = require('../utils/esignUploadTypes');

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ESIGN_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = isAllowedEsignUpload(file.originalname || '', file.mimetype || '');
    if (!ok) {
      const err = new Error(`Only ${ESIGN_UPLOAD_LABEL} files are supported`);
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

function handleMulterError(err, _req, res, next) {
  if (!err) return next();
  const statusCode = err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 400);
  const message =
    err.code === 'LIMIT_FILE_SIZE'
      ? `Document must be ${ESIGN_UPLOAD_SIZE_LABEL} or smaller`
      : err.message || 'File upload failed';
  return res.status(statusCode).json({
    message,
    statuscode: statusCode,
    data: null,
  });
}

const uploadTemplateFromDocument = [
  authMiddleware,
  (req, res, next) => {
    documentUpload.single('file')(req, res, (err) => handleMulterError(err, req, res, next));
  },
  docusealController.createTemplateFromUpload,
];

// Authenticated portal users can use DocuSeal embeds and API helpers.
router.get('/status', authMiddleware, docusealController.getStatus);
router.post('/builder_token', authMiddleware, docusealController.createBuilderToken);
router.post('/signing_token', authMiddleware, docusealController.createSigningToken);
router.get('/templates', authMiddleware, docusealController.listTemplates);
router.post('/templates/pdf', ...uploadTemplateFromDocument);
router.post('/templates/upload', ...uploadTemplateFromDocument);
router.get('/templates/:id', authMiddleware, docusealController.getTemplate);
router.get('/submissions', authMiddleware, docusealController.listSubmissions);
router.get('/submissions/:id', authMiddleware, docusealController.getSubmission);
router.post('/submissions', authMiddleware, docusealController.createSubmission);
router.post('/send', authMiddleware, docusealController.sendForSignature);

// Local signing tracker (who sent / to whom / status)
router.post('/signing-records', authMiddleware, docusealController.createSigningRecord);
router.get('/signing-records', authMiddleware, docusealController.listSigningRecords);
router.get('/signing-records/:id', authMiddleware, docusealController.getSigningRecord);
router.post(
  '/signing-records/:id/refresh',
  authMiddleware,
  docusealController.refreshSigningRecord
);
router.post(
  '/signing-records/:id/resend',
  authMiddleware,
  docusealController.resendSigningInvite
);

module.exports = router;
