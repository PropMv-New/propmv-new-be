/**
 * ------------------------------------------------------------------
 * File: paginationHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for paginationHelper.
 *
 * Used By:
 * mongooseHelpers, schemaPlugins, expense.service, payee.service
 * ------------------------------------------------------------------
 */

/**
 * Configurable pagination helper for Mongoose and other DB queries
 * @param {Object} options - Pagination options
 * @param {number} options.page - Current page number
 * @param {number} options.limit - (legacy) Items per page
 * @param {number} options.pageSize - Preferred items per page
 * @returns {Object} - { offset, limit, page, pageSize }
 */
function getPagination({ page, limit, pageSize } = {}) {
  let pageNum = parseInt(page);
  let pageSizeNum = parseInt(pageSize);
  let limitNum = parseInt(limit);

  if (!pageNum || pageNum < 1) pageNum = 1;

  // Decide effective page size:
  // - If pageSize is explicitly 0 -> treat as 'no pagination' (return all results)
  // - Else prefer positive pageSize, fall back to positive limit, else default to 10
  let effectivePageSize;
  if (typeof pageSize !== 'undefined' && !isNaN(pageSizeNum) && pageSizeNum === 0) {
    effectivePageSize = 0; // signal no pagination
  } else if (pageSizeNum && pageSizeNum > 0) {
    effectivePageSize = pageSizeNum;
  } else if (limitNum && limitNum > 0) {
    effectivePageSize = limitNum;
  } else {
    effectivePageSize = 10;
  }

  return {
    offset: effectivePageSize === 0 ? 0 : (pageNum - 1) * effectivePageSize,
    limit: effectivePageSize,
    page: pageNum,
    pageSize: effectivePageSize,
  };
}

module.exports = {
  getPagination,
};
