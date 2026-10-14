const mongoose = require('mongoose');
const User = require('../../users/models/user.model');
const { buildActiveHoaIdMatch } = require('../../../../middleware/hoaDataIsolation');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build Mongo `$or` clauses for maintenance list search.
 * Matches title, ticket number, description, property name, and requester/creator.
 */
async function buildMaintenanceSearchOrClauses(searchText, userContext = null) {
  const text = String(searchText || '').trim();
  if (!text) return null;

  const searchRegex = { $regex: escapeRegex(text), $options: 'i' };
  const clauses = [
    { title: searchRegex },
    { ticketNumber: searchRegex },
    { description: searchRegex },
    { createdByName: searchRegex },
  ];

  try {
    const Property = require('../../../../portals/hoa-board/modules/property/model/property.model');
    const propFilter = {
      isDeleted: { $ne: true },
      name: searchRegex,
    };
    const hoaMatch = buildActiveHoaIdMatch(userContext);
    if (hoaMatch) {
      Object.assign(propFilter, hoaMatch);
    }
    const props = await Property.find(propFilter).select('_id').limit(100).lean();
    if (props.length > 0) {
      clauses.push({ property_id: { $in: props.map((p) => p._id) } });
    }
  } catch (_) {
    // Property model may be unavailable in some test contexts - title/ticket search still works.
  }

  try {
    const users = await User.find({
      $or: [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
      ],
    })
      .select('_id')
      .limit(100)
      .lean();
    if (users.length > 0) {
      const ids = users
        .map((u) => u._id)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)));
      if (ids.length > 0) {
        clauses.push({ requestedBy: { $in: ids } });
        clauses.push({ createdBy: { $in: ids } });
      }
    }
  } catch (_) {
    // User lookup failures should not block title/ticket search.
  }

  return clauses;
}

module.exports = {
  escapeRegex,
  buildMaintenanceSearchOrClauses,
};
