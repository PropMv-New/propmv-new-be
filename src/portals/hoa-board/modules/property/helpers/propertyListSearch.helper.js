/**
 * Property list text search helpers for the HOA board Properties page.
 *
 * Matches fields visible in the Properties listing table:
 * property name, unit number/name, address, and owner details.
 *
 * Owner search must resolve live User records and match via associatedOwnerIds /
 * User.propertyIds. Relying only on denormalized Property.ownerName misses
 * co-owners and units whose legacy ownerName was never updated.
 */

const User = require('../../../../../shared/modules/users/models/user.model');
const hoaOwnerRole = require('../../../../../common/helpers/hoaOwnerRole');
const { toObjectId } = require('../../../../../common/db/mongooseHelpers');

const DEFAULT_OWNER_LOOKUP_LIMIT = 200;

function defaultEscapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merge a text-search `$or` clause into a Mongo filter that may already contain
 * HOA isolation `$and` / `$or` (from applyHOADataFilter). Assigning search onto
 * `filter.$or` directly would clobber board isolation and return the full list.
 */
function mergeSearchClauseIntoFilter(filter, searchClause) {
  if (!filter || !searchClause) return filter;
  if (Array.isArray(filter.$and)) {
    filter.$and.push(searchClause);
  } else if (filter.$or) {
    filter.$and = [{ $or: filter.$or }, searchClause];
    delete filter.$or;
  } else {
    Object.assign(filter, searchClause);
  }
  return filter;
}

/**
 * Owner name match: first/last/email/phone field regex plus concatenated
 * "first last" so partial full-name queries like "John Sm" work.
 */
function buildOwnerUserMatchClauses(searchText, escapeRegex = defaultEscapeRegex) {
  const text = String(searchText || '').trim();
  if (!text) return [];

  const escape = typeof escapeRegex === 'function' ? escapeRegex : defaultEscapeRegex;
  const escaped = escape(text);
  const searchRegex = { $regex: escaped, $options: 'i' };

  const clauses = [
    { firstName: searchRegex },
    { lastName: searchRegex },
    { email: searchRegex },
    { phone: searchRegex },
    {
      $expr: {
        $regexMatch: {
          input: {
            $trim: {
              input: {
                $concat: [
                  { $ifNull: ['$firstName', ''] },
                  ' ',
                  { $ifNull: ['$lastName', ''] },
                ],
              },
            },
          },
          regex: escaped,
          options: 'i',
        },
      },
    },
  ];

  // Multi-token: require each token to appear in first or last name so
  // "john smith" still matches when only field-level regex would miss.
  const tokens = text.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length > 1) {
    clauses.push({
      $and: tokens.map((token) => {
        const tokenRegex = { $regex: escape(token), $options: 'i' };
        return {
          $or: [
            { firstName: tokenRegex },
            { lastName: tokenRegex },
          ],
        };
      }),
    });
  }

  return clauses;
}

/**
 * Find HOA owner user ids (and linked property ids) matching a search string.
 */
async function findOwnersMatchingPropertySearch(searchText, options = {}) {
  const text = String(searchText || '').trim();
  if (!text) {
    return { ownerIds: [], propertyIdsFromOwners: [] };
  }

  const escape = typeof options.escapeRegex === 'function' ? options.escapeRegex : defaultEscapeRegex;
  const limit = Math.min(
    Math.max(Number(options.limit) || DEFAULT_OWNER_LOOKUP_LIMIT, 1),
    500,
  );

  const nameClauses = buildOwnerUserMatchClauses(text, escape);
  if (!nameClauses.length) {
    return { ownerIds: [], propertyIdsFromOwners: [] };
  }

  let ownerRoleFilter = null;
  try {
    ownerRoleFilter = await hoaOwnerRole.buildHOAOwnerUserFilter();
  } catch (_) {
    // Role lookup can fail in isolated tests - still search users by name.
    ownerRoleFilter = null;
  }

  const userFilter = ownerRoleFilter
    ? { $and: [ownerRoleFilter, { $or: nameClauses }] }
    : { $or: nameClauses };

  const matchingOwners = await User.find(userFilter)
    .select('_id propertyIds')
    .limit(limit)
    .lean();

  const ownerIds = [];
  const propertyIdSet = new Set();
  for (const owner of matchingOwners || []) {
    if (owner?._id) ownerIds.push(owner._id);
    for (const pid of owner.propertyIds || []) {
      const oid = toObjectId(pid);
      if (oid) propertyIdSet.add(String(oid));
    }
  }

  return {
    ownerIds,
    propertyIdsFromOwners: [...propertyIdSet]
      .map((id) => toObjectId(id))
      .filter(Boolean),
  };
}

/**
 * Sync text-search clause for fields stored on the Property document
 * (name, unit, address, denormalized owner contact fields).
 */
function buildPropertyTextSearchClause(search, escapeRegex) {
  const text = String(search || '').trim();
  if (!text) return null;
  const escape = typeof escapeRegex === 'function' ? escapeRegex : defaultEscapeRegex;
  const searchRegex = { $regex: escape(text), $options: 'i' };
  return {
    $or: [
      { name: searchRegex },
      { 'unitDetails.unitName': searchRegex },
      { 'address.street': searchRegex },
      { 'address.line2': searchRegex },
      { 'address.addressLine2': searchRegex },
      { 'address.city': searchRegex },
      { 'address.state': searchRegex },
      { 'address.zip': searchRegex },
      { 'address.country': searchRegex },
      { ownerName: searchRegex },
      { ownerEmail: searchRegex },
      { ownerPhone: searchRegex },
    ],
  };
}

/**
 * Async property list search clause: denormalized property/owner fields plus live
 * associatedOwnerIds / User.propertyIds matches for partial owner-name search.
 */
async function buildPropertyTextSearchClauseWithOwners(search, escapeRegex) {
  const base = buildPropertyTextSearchClause(search, escapeRegex);
  if (!base) return null;

  const { ownerIds, propertyIdsFromOwners } = await findOwnersMatchingPropertySearch(search, {
    escapeRegex,
  });

  const orClauses = [...base.$or];
  if (ownerIds.length > 0) {
    orClauses.push({ associatedOwnerIds: { $in: ownerIds } });
  }
  if (propertyIdsFromOwners.length > 0) {
    orClauses.push({ _id: { $in: propertyIdsFromOwners } });
  }

  return { $or: orClauses };
}

module.exports = {
  mergeSearchClauseIntoFilter,
  buildPropertyTextSearchClause,
  buildPropertyTextSearchClauseWithOwners,
  buildOwnerUserMatchClauses,
  findOwnersMatchingPropertySearch,
  defaultEscapeRegex,
};
