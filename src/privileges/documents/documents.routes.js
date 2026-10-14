/**
 * Document API Privileges (shared /api/v1/documents - HOA + landlord consumers)
 */

const {
  PRIVILEGE_VIEW_DOCUMENTS,
  PRIVILEGE_CREATE_DOCUMENTS,
  PRIVILEGE_EDIT_DOCUMENTS,
  PRIVILEGE_DELETE_DOCUMENTS,
} = require('../../common/constants/privileges');

module.exports = {
  // HOA document vault
  'GET /api/v1/documents/hoa': [PRIVILEGE_VIEW_DOCUMENTS],
  'GET /api/v1/documents/hoa/by-owner/:ownerId': [PRIVILEGE_VIEW_DOCUMENTS],
  'GET /api/v1/documents/hoa/:categoryId': [PRIVILEGE_VIEW_DOCUMENTS],
  'POST /api/v1/documents/hoa/upload': [PRIVILEGE_CREATE_DOCUMENTS],
  'PATCH /api/v1/documents/hoa/document/:documentId': [PRIVILEGE_EDIT_DOCUMENTS],
  'DELETE /api/v1/documents/hoa/:documentId': [PRIVILEGE_DELETE_DOCUMENTS],

  // Generic document metadata / download / delete
  'GET /api/v1/documents/:id': [PRIVILEGE_VIEW_DOCUMENTS],
  'GET /api/v1/documents/:id/url': [PRIVILEGE_VIEW_DOCUMENTS],
  'GET /api/v1/documents/:id/download': [PRIVILEGE_VIEW_DOCUMENTS],
  'DELETE /api/v1/documents/:id': [PRIVILEGE_DELETE_DOCUMENTS],
};
