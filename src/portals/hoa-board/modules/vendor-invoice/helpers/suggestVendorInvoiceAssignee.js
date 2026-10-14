const { roleKeyFromName } = require('../../../../../common/helpers/maintenanceEmailContent');

function idString(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function collectTicketPartyIds(ticket) {
  const ids = [];
  const push = (value) => {
    const id = idString(value);
    if (id && id !== 'undefined' && id !== 'null') ids.push(id);
  };
  const requestedBy = ticket?.requestedBy;
  if (Array.isArray(requestedBy)) requestedBy.forEach(push);
  else if (requestedBy) push(requestedBy);
  push(ticket?.createdBy);
  return [...new Set(ids)];
}

function userTypeFromRoleName(roleName) {
  const key = roleKeyFromName(roleName);
  if (key === 'hoa_board') return 'board_member';
  if (key === 'hoa_owner') return 'owner';
  if (key === 'tenant') return 'tenant';
  if (key === 'landlord') return 'landlord';
  if (key === 'property_manager') return 'property_manager';
  return 'board_member';
}

/**
 * Default invoice assignee from the ticket's requester / creator, then role match.
 */
function suggestVendorInvoiceAssigneeId(users, ticket) {
  if (!Array.isArray(users) || users.length === 0) return null;
  const byId = new Map(users.map((user) => [idString(user.id || user._id), user]));
  const pick = (value) => {
    const id = idString(value);
    return id && byId.has(id) ? id : null;
  };

  for (const id of collectTicketPartyIds(ticket)) {
    const found = pick(id);
    if (found) return found;
  }

  const preferredType = userTypeFromRoleName(ticket?.createdByRole);
  const typed = users.find((user) => user.userType === preferredType);
  if (typed) return idString(typed.id || typed._id);

  const owner = users.find((user) => user.userType === 'owner');
  if (owner) return idString(owner.id || owner._id);

  return idString(users[0].id || users[0]._id);
}

module.exports = {
  collectTicketPartyIds,
  userTypeFromRoleName,
  suggestVendorInvoiceAssigneeId,
};
