/**
 * ------------------------------------------------------------------
 * File: schemaPlugins.js
 * Module: Src Common Db
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * invoice.model, listing.model, message.model, maintenanceRequest.model
 * ------------------------------------------------------------------
 */

const { getPagination } = require('../helpers/paginationHelper');

/**
 * Adds reusable query helpers to a Mongoose schema.
 */
function commonQueryHelpersPlugin(schema) {
  schema.query.notDeleted = function notDeleted() {
    return this.where({ isDeleted: { $ne: true } });
  };

  schema.query.activeOnly = function activeOnly() {
    return this.notDeleted().where({ isArchived: { $ne: true } });
  };
}

/**
 * Adds paginate static to a Mongoose model.
 */
function paginateStaticPlugin(schema) {
  schema.statics.paginate = async function paginate(filter, options = {}) {
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

    let query = this.find(filter).sort(sort);
    if (select) query = query.select(select);
    if (populate) query = query.populate(populate);
    if (lean) query = query.lean();

    const [total, docs] = await Promise.all([
      this.countDocuments(filter).exec(),
      query.skip(offset).limit(effectiveLimit || 0).exec(),
    ]);

    return {
      total,
      page: pageNum,
      pageSize: effectivePageSize,
      docs,
    };
  };
}

module.exports = {
  commonQueryHelpersPlugin,
  paginateStaticPlugin,
};
