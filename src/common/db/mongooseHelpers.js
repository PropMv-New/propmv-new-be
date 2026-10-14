/**
 * ------------------------------------------------------------------
 * File: mongooseHelpers.js
 * Module: Src Common Db
 *
 * Purpose:
 * Backend utility/module providing helper functions for mongooseHelpers.
 *
 * Used By:
 * leaseQueryHelpers, propertyRelatedQueries, expense.model, invoice.model
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { getPagination } = require('../helpers/paginationHelper');

/**
 * Safely convert a value to MongoDB ObjectId.
 */
function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const str = String(typeof id === 'object' && id._id ? id._id : id).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * Escape a string for use in a RegExp pattern (exact-match safe).
 */
function escapeRegex(value) {
  if (!value) return '';
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a Date to midnight (start of day) in local time.
 */
function normalizeDateToStartOfDay(date) {
  const d = date ? new Date(date) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Apply lean() when read-only hydration is not required.
 */
function asLean(query, lean = true) {
  return lean ? query.lean() : query;
}

/**
 * Execute a Mongoose query and return results (explicit .exec()).
 */
async function execQuery(query) {
  return query.exec();
}

/**
 * Recursively strip any key that starts with '$' from a plain filter object
 * to prevent NoSQL operator injection via untrusted input.
 * Non-plain values (ObjectId, RegExp, Date, primitives) are returned as-is.
 */
function sanitizeFilter(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (value instanceof RegExp || value instanceof Date) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('$'))
      .map(([key, val]) => {
        if (val instanceof mongoose.Types.ObjectId) return [key, val];
        if (typeof val === 'string' && val.length === 24 && mongoose.Types.ObjectId.isValid(val)) {
          return [key, new mongoose.Types.ObjectId(val)];
        }
        return [key, sanitizeFilter(val)];
      })
  );
}

/**
 * Paginate a find query using skip/limit.
 */
async function paginateFind(Model, filter, options = {}) {
  const {
    page,
    limit,
    pageSize,
    sort = {},
    select,
    lean = true,
    populate,
  } = options;

  const { offset, limit: effectiveLimit, page: pageNum, pageSize: effectivePageSize } = getPagination({
    page,
    limit,
    pageSize,
  });

  const safeFilter = sanitizeFilter(filter);
  const safeSort = sanitizeSort(sort);

  let query = Model.find(safeFilter).sort(safeSort);
  if (select) query = query.select(select);
  if (populate) query = query.populate(populate);

  const [total, docs] = await Promise.all([
    Model.countDocuments(safeFilter).exec(),
    asLean(
      query.skip(offset).limit(effectiveLimit || 0),
      lean
    ).exec(),
  ]);

  return {
    total,
    page: pageNum,
    pageSize: effectivePageSize,
    offset,
    limit: effectiveLimit,
    docs,
  };
}

/**
 * Paginate an aggregation pipeline with $facet.
 */
async function paginateAggregate(Model, pipeline, options = {}) {
  const { page, limit, pageSize } = options;
  const { offset, limit: effectiveLimit, page: pageNum, pageSize: effectivePageSize } = getPagination({
    page,
    limit,
    pageSize,
  });

  const safePipeline = sanitizePipeline(pipeline);

  const facetPipeline = [
    ...safePipeline,
    {
      $facet: {
        data: [
          ...(effectiveLimit > 0 ? [{ $skip: offset }, { $limit: effectiveLimit }] : []),
        ],
        total: [{ $count: 'count' }],
      },
    },
  ];

  const [result] = await Model.aggregate(facetPipeline).exec();
  const total = result?.total?.[0]?.count || 0;

  return {
    total,
    page: pageNum,
    pageSize: effectivePageSize,
    offset,
    limit: effectiveLimit,
    docs: result?.data || [],
  };
}

/**
 * Sanitize a sort object - only allow keys without '$' and values of 1/-1/asc/desc.
 */
function sanitizeSort(sort) {
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) return {};
  return Object.fromEntries(
    Object.entries(sort)
      .filter(([key]) => !key.startsWith('$'))
      .filter(([, val]) => val === 1 || val === -1 || val === 'asc' || val === 'desc')
  );
}

/**
 * Sanitize an aggregation pipeline - must be an array of plain objects.
 */
function sanitizePipeline(pipeline) {
  if (!Array.isArray(pipeline)) return [];
  return pipeline.filter(
    (stage) => stage !== null && typeof stage === 'object' && !Array.isArray(stage)
  );
}

/**
 * Build a case-insensitive exact-match regex for unit names.
 */
function exactUnitNameRegex(unitName) {
  return { $regex: `^${escapeRegex(String(unitName))}$`, $options: 'i' };
}

module.exports = {
  toObjectId,
  escapeRegex,
  sanitizeFilter,
  sanitizeSort,
  sanitizePipeline,
  normalizeDateToStartOfDay,
  asLean,
  execQuery,
  paginateFind,
  paginateAggregate,
  exactUnitNameRegex,
};
