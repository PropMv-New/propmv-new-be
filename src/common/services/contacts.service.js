/**
 * ------------------------------------------------------------------
 * File: contacts.service.js
 * Module: Src Common Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * message.service, emailContacts.controller
 * ------------------------------------------------------------------
 */

const { connectToDatabase } = require('../../database');
const User = require('../../shared/modules/users/models/user.model');
const Lease = require('../../portals/landlord/modules/leasing/model/lease.model');
const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const HOAMembership = require('../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const MaintenanceRequest = require('../../shared/modules/maintenance/model/maintenanceRequest.model');
const { LEASE_STATUSES } = require('../constants/lease');
const { USER_STATUSES } = require('../constants/user');
const { resolveUserRoleName } = require('../helpers/companyRoleHelper');
const { isHOABoardMemberRole } = require('../helpers/hoaBoardRole');
const { isHOAOwnerRole, buildHOAOwnerUserFilter } = require('../helpers/hoaOwnerRole');
const { isVendorRole, buildVendorUserFilter } = require('../helpers/hoaVendorRole');
const { isValidEmail } = require('../helpers/validationHelper');
const {
  buildHoaOwnerUserFilter,
  buildVendorHoaAssociationFilter,
  loadHoaMemberUserIds,
} = require('../../middleware/hoaDataIsolation');

const CONTACTS_RESULT_CACHE_TTL_MS = 60 * 1000;
const PROPERTY_OWNER_CACHE_TTL_MS = 60 * 1000;

/** @type {Map<string, { contacts: Array, ts: number }>} */
const _contactsResultCache = new Map();
/** @type {Map<string, { data: { propertyIds: Array, associatedOwnerIds: string[] }, ts: number }>} */
const _propertyOwnerCache = new Map();

function buildContactsOptionsFromRequest(req, extra = {}) {
  const associatedFromContext = Array.isArray(req.hoaContext?.associatedHoaIds)
    ? req.hoaContext.associatedHoaIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const hoaId =
    req.hoaContext?.hoaId
    || associatedFromContext[0]
    || req.headers?.['x-hoa-id']
    || req.query?.hoaId
    || req.body?.hoaId;
  const options = { ...extra };
  if (hoaId || req.hoaContext) {
    options.isHOA = true;
  }
  if (hoaId) {
    options.hoaId = String(hoaId).trim();
  }
  const maintenanceRequestId =
    req.query?.maintenanceRequestId
    || req.body?.maintenanceRequestId
    || req.headers?.['x-maintenance-request-id'];
  if (maintenanceRequestId) {
    options.maintenanceRequestId = String(maintenanceRequestId).trim();
  }
  if (req.hoaContext) {
    options.hoaContext = req.hoaContext;
  }
  if (req.userRoleName) {
    options.roleName = req.userRoleName;
  }
  if (req.authCompany) {
    options.authCompany = req.authCompany;
  }
  if (req.authUser) {
    options.user = req.authUser;
  }
  return options;
}

function mapUserToContact(contact, boardMemberIdSet) {
  const firstName = contact.firstName || '';
  const lastName = contact.lastName || '';
  const id = toIdString(contact._id);
  const contactType = boardMemberIdSet.has(id)
    ? 'board_member'
    : (contact.type || 'hoa_owner');

  return {
    id: contact._id,
    _id: contact._id,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || contact.email,
    email: contact.email,
    phone: contact.phone || '',
    type: contactType,
    propertyIds: Array.isArray(contact.propertyIds) ? contact.propertyIds : [],
  };
}

function summarizeProperty(property) {
  const unit = Array.isArray(property?.unitDetails) ? property.unitDetails[0] : null;
  return {
    id: toIdString(property?._id),
    name: property?.name || '',
    unitName: (unit && unit.unitName) || '',
  };
}

function attachPropertiesToContacts(contacts, propertiesByOwnerId, propertiesById) {
  return (contacts || []).map((contact) => {
    const id = toIdString(contact.id || contact._id);
    const seen = new Set();
    const properties = [];
    const add = (item) => {
      if (!item?.id || seen.has(item.id)) return;
      seen.add(item.id);
      properties.push({
        id: item.id,
        name: item.name || '',
        unitName: item.unitName || '',
      });
    };

    (propertiesByOwnerId[id] || []).forEach(add);
    if (properties.length === 0) {
      (contact.propertyIds || []).forEach((propertyId) => {
        add(propertiesById[toIdString(propertyId)]);
      });
    }

    const { propertyIds, ...rest } = contact;
    const primary = properties[0] || null;
    return {
      ...rest,
      properties,
      property: primary?.name || '',
      unit: primary?.unitName || '',
    };
  });
}

function contactMatchesSearch(contact, searchText) {
  const query = String(searchText || '').trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    contact.firstName,
    contact.lastName,
    contact.name,
    contact.email,
    contact.phone,
    contact.type,
    contact.property,
    contact.unit,
    ...(Array.isArray(contact.properties) ? contact.properties.flatMap((item) => [item.name, item.unitName]) : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

async function loadHoaPropertyOwnerData(hoaId) {
  const cacheKey = `owners_${hoaId}`;
  const cached = _propertyOwnerCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < PROPERTY_OWNER_CACHE_TTL_MS) {
    return cached.data;
  }

  const properties = await Property.find({
    hoaId,
    isDeleted: { $ne: true },
  })
    .select('_id name unitDetails.unitName associatedOwnerIds')
    .lean();

  const propertyIds = properties.map((p) => p._id).filter(Boolean);
  const ownerIdSet = new Set();
  const propertiesByOwnerId = {};
  const propertiesById = {};

  properties.forEach((property) => {
    const summary = summarizeProperty(property);
    if (summary.id) propertiesById[summary.id] = summary;
    (property.associatedOwnerIds || []).forEach((ownerId) => {
      const id = toIdString(ownerId);
      if (!id) return;
      ownerIdSet.add(id);
      if (!propertiesByOwnerId[id]) propertiesByOwnerId[id] = [];
      if (!propertiesByOwnerId[id].some((item) => item.id === summary.id)) {
        propertiesByOwnerId[id].push(summary);
      }
    });
  });

  const data = {
    propertyIds,
    associatedOwnerIds: [...ownerIdSet],
    propertiesByOwnerId,
    propertiesById,
  };
  _propertyOwnerCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

function invalidateContactsCaches(hoaId) {
  if (!hoaId) return;
  const hoaKey = String(hoaId);
  _propertyOwnerCache.delete(`owners_${hoaKey}`);
  for (const key of _contactsResultCache.keys()) {
    if (key.includes(`:${hoaKey}:`)) {
      _contactsResultCache.delete(key);
    }
  }
}

/**
 * to Id String
 *
 * Performs logic operations for toIdString.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function toIdString(id) {
  if (!id) return '';
  return id.toString ? id.toString() : String(id);
}

function pushContactId(set, value, excludeId) {
  const id = toIdString(value && value._id ? value._id : value);
  if (id && id !== excludeId) set.add(id);
}

/**
 * Vendor contacts for a maintenance ticket: only users directly on the ticket
 * (creator / requester). Do not include other board members, property owners,
 * tenants, or community members who are not ticket parties.
 */
function collectVendorMaintenanceContactIds({
  ticket,
  vendorUserId,
} = {}) {
  const contactIds = new Set();
  const exclude = toIdString(vendorUserId);

  pushContactId(contactIds, ticket?.createdBy, exclude);
  const requestedBy = ticket?.requestedBy;
  if (Array.isArray(requestedBy)) {
    requestedBy.forEach((value) => pushContactId(contactIds, value, exclude));
  } else if (requestedBy) {
    pushContactId(contactIds, requestedBy, exclude);
  }

  return contactIds;
}

/** Email compose: include community board members + property owners for vendor-associated HOAs. */
function wantsVendorEmailCommunityContacts(options = {}) {
  return String(options.contactPurpose || '').toLowerCase() === 'email';
}

/**
 * Collect board member + property owner user ids across one or more HOAs for vendor email.
 */
async function collectVendorEmailCommunityContactIds(vendorHoaIds = [], vendorUserId) {
  const contactIds = new Set();
  const exclude = toIdString(vendorUserId);
  const hoaIds = [...new Set((vendorHoaIds || []).map(toIdString).filter(Boolean))];

  await Promise.all(
    hoaIds.map(async (hoaId) => {
      try {
        const [boardMemberIds, propertyOwnerData] = await Promise.all([
          loadHoaMemberUserIds(hoaId),
          loadHoaPropertyOwnerData(hoaId),
        ]);
        (boardMemberIds || []).forEach((memberId) => {
          const id = toIdString(memberId);
          if (id && id !== exclude) contactIds.add(id);
        });
        (propertyOwnerData?.associatedOwnerIds || []).forEach((ownerId) => {
          const id = toIdString(ownerId);
          if (id && id !== exclude) contactIds.add(id);
        });
      } catch (_) {
        // Best-effort per community — keep other HOAs usable.
      }
    })
  );

  return contactIds;
}

function mergePropertyOwnerMaps(target, source) {
  if (!source) return target;
  Object.entries(source.propertiesByOwnerId || {}).forEach(([ownerId, props]) => {
    if (!target.propertiesByOwnerId[ownerId]) target.propertiesByOwnerId[ownerId] = [];
    (props || []).forEach((item) => {
      if (!item?.id) return;
      if (!target.propertiesByOwnerId[ownerId].some((existing) => existing.id === item.id)) {
        target.propertiesByOwnerId[ownerId].push(item);
      }
    });
  });
  Object.entries(source.propertiesById || {}).forEach(([id, summary]) => {
    if (id && summary) target.propertiesById[id] = summary;
  });
  return target;
}

/**
 * Map a resolved role name to a chat/email contact type so ticket requesters
 * (owner, tenant, landlord, property manager, board) label correctly.
 */
function contactTypeFromRoleName(roleName) {
  const n = String(roleName || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n) return 'hoa_owner';
  if (n.includes('vendor') || n.includes('contractor')) return 'vendor';
  if (n.includes('tenant')) return 'tenant';
  if (n.includes('landlord')) return 'landlord';
  if (n.includes('property manager') || n === 'property_manager' || n === 'pm') {
    return 'property_manager';
  }
  if (isHOABoardMemberRole(roleName) || n.includes('board')) return 'board_member';
  if (isHOAOwnerRole(roleName) || n.includes('owner')) return 'hoa_owner';
  return 'hoa_owner';
}

/** Only users with Active status may receive emails or chats. */
function activeUserStatusFilter() {
  return { status: USER_STATUSES.ACTIVE };
}

/**
 * Common Contacts Service
 * Provides contact retrieval logic for both email and messaging features
 *
 * Supports:
 * - Landlord: Can message tenants with active/approved leases
 * - Tenant: Can message their landlord
 * - HOA Board Member: Can message other board members + all owners of the same community + vendors
 * - HOA Owner: Can message board members + other owners of the same unit + vendors (same as board)
 * - Vendor messaging: With maintenanceRequestId → only that ticket's requester/creator;
 *   without ticket → requesters/creators from tickets assigned to the vendor (+ prior chat partners)
 * - Vendor email (contactPurpose=email): board members + property owners of associated HOAs
 *   (plus ticket parties / prior partners), and freeform valid email recipients are allowed
 */
class ContactsService {
  /**
   * Get contacts for a user (tenants for landlord, landlord for tenant, etc.)
   * @param {string} userId - The user ID
   * @param {string} searchText - Optional search text
   * @param {Object} options - Additional options (e.g., { isHOA: true, hoaId: hoaId })
   * @returns {Promise<Array>} Array of contacts
   */
  async getContacts(userId, searchText = '', options = {}) {
    await connectToDatabase();

    const user = options.user || await User.findById(userId)
      .select('companyId companyRoleId landlordId hoaInfo propertyIds associatedHoaIds')
      .lean();
    if (!user) {
      throw new Error('User not found');
    }

    const roleName = options.roleName
      ? String(options.roleName).toLowerCase()
      : (await resolveUserRoleName(user, { company: options.authCompany }))?.toLowerCase();
    const isHOAUser = options.isHOA || options.hoaId
      || isHOABoardMemberRole(roleName)
      || isHOAOwnerRole(roleName)
      || isVendorRole(roleName);
    let contacts = [];

    if (isHOAUser || user.hoaInfo?.hoaId || (user.associatedHoaIds || []).length) {
      const hoaId = options.hoaId || (await this.resolveHoaIdForUser(user));
      // Vendors may still resolve ticket / prior-message contacts without a scoped hoaId.
      if (!hoaId && !isVendorRole(roleName)) {
        return [];
      }
      contacts = await this.getHOAContacts(userId, hoaId, searchText, {
        ...options,
        user,
        roleName,
      });
    } else if (roleName === 'tenant' && user.landlordId) {
      // Tenant can only contact their landlord
      const landlord = await User.findOne({
        _id: user.landlordId,
        ...activeUserStatusFilter(),
        isDeleted: { $ne: true },
      }).select('firstName lastName email phone');
      if (landlord) {
        const firstName = landlord.firstName || '';
        const lastName = landlord.lastName || '';
        contacts = [{
          id: landlord._id,
          _id: landlord._id,
          firstName,
          lastName,
          name: `${firstName} ${lastName}`.trim() || landlord.email,
          email: landlord.email,
          phone: landlord.phone || '',
          type: 'landlord'
        }];
      }
    } else if (roleName === 'landlord') {
      // Landlord can only contact tenants with Approved or Active leases

      // Find all leases for this landlord's properties with Approved or Active status
      const leases = await Lease.find({
        status: { $in: [LEASE_STATUSES.APPROVED, LEASE_STATUSES.ACTIVE] }
      })
        .populate({
          path: 'property_id',
          match: { landlord_id: userId },
          select: '_id'
        })
        .select('rentAndDepositDestribution');

      // Filter out leases where property_id is null (not belonging to this landlord)
      const validLeases = leases.filter(lease => lease.property_id !== null);

      // Extract unique tenant IDs from lease splits
      const tenantIds = new Set();
      validLeases.forEach(lease => {
        if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
          lease.rentAndDepositDestribution.split.forEach(split => {
            if (split.tenantId) {
              tenantIds.add(split.tenantId.toString());
            }
          });
        }
      });

      if (tenantIds.size > 0) {
        // Build query for tenants
        const query = {
          _id: { $in: Array.from(tenantIds) },
          isDeleted: false,
          ...activeUserStatusFilter(),
        };

        if (searchText) {
          query.$or = [
            { firstName: { $regex: searchText, $options: 'i' } },
            { lastName: { $regex: searchText, $options: 'i' } },
            { email: { $regex: searchText, $options: 'i' } }
          ];
        }

        const tenants = await User.find(query)
          .select('firstName lastName email phone')
          .limit(50);

        contacts = tenants.map(tenant => {
          const firstName = tenant.firstName || '';
          const lastName = tenant.lastName || '';
          return {
            id: tenant._id,
            _id: tenant._id,
            firstName,
            lastName,
            name: `${firstName} ${lastName}`.trim() || tenant.email,
            email: tenant.email,
            phone: tenant.phone || '',
            type: 'tenant'
          };
        });
      }
    }

    return contacts;
  }

  /**
   * Resolve HOA id for an owner/board/vendor user when options.hoaId / hoaInfo are missing.
   */
  async resolveHoaIdForUser(user) {
    if (user?.hoaInfo?.hoaId) {
      return toIdString(user.hoaInfo.hoaId);
    }

    let associated = Array.isArray(user?.associatedHoaIds) ? user.associatedHoaIds.filter(Boolean) : [];
    // Auth-cached users may omit associatedHoaIds - reload so vendors can still resolve contacts.
    if (!associated.length && user?._id) {
      const fresh = await User.findById(user._id).select('associatedHoaIds hoaInfo propertyIds').lean();
      if (fresh?.hoaInfo?.hoaId) {
        return toIdString(fresh.hoaInfo.hoaId);
      }
      associated = Array.isArray(fresh?.associatedHoaIds) ? fresh.associatedHoaIds.filter(Boolean) : [];
      if (associated.length) {
        return toIdString(associated[0]);
      }
      const propertyIds = Array.isArray(fresh?.propertyIds) ? fresh.propertyIds.filter(Boolean) : [];
      if (propertyIds.length) {
        const prop = await Property.findOne({
          _id: { $in: propertyIds },
          hoaId: { $ne: null },
          isDeleted: { $ne: true },
        })
          .select('hoaId')
          .lean();
        return prop?.hoaId ? toIdString(prop.hoaId) : null;
      }
      return null;
    }
    if (associated.length) {
      return toIdString(associated[0]);
    }

    const membership = await HOAMembership.findOne({
      userId: user._id,
      status: 'active',
    })
      .sort({ createdAt: 1 })
      .select('hoaId')
      .lean();
    if (membership?.hoaId) {
      return toIdString(membership.hoaId);
    }

    const propertyIds = Array.isArray(user.propertyIds) ? user.propertyIds.filter(Boolean) : [];
    if (propertyIds.length === 0) return null;

    const prop = await Property.findOne({
      _id: { $in: propertyIds },
      hoaId: { $ne: null },
      isDeleted: { $ne: true },
    })
      .select('hoaId')
      .lean();

    return prop?.hoaId ? toIdString(prop.hoaId) : null;
  }

  /**
   * Get HOA contacts for HOA board members and owners
   *
 * HOA Board Members can message/email:
 *   - All other active board members of the same HOA
 *   - All property owners in the HOA community
 *   - All vendors associated with the HOA
 *
 * HOA Owners can message/email:
 *   - HOA board members of that community
 *   - Other owners of the same unit (same property) only
 *   - All vendors associated with the HOA (same vendor access as board members)
 *
 * Vendors can message/email:
 *   - With maintenanceRequestId: only the ticket requester(s)/creator for that ticket
 *   - Without maintenanceRequestId: requesters/creators from maintenance tickets
 *     assigned to this vendor (no unrelated community members)
 *
   * @param {string} userId - The user ID
   * @param {string} hoaId - The HOA ID
   * @param {string} searchText - Optional search text
   * @param {Object} options - Additional options (e.g., { maintenanceRequestId })
   * @returns {Promise<Array>} Array of contacts
   */
  async getHOAContacts(userId, hoaId, searchText = '', options = {}) {
    const hoaContext = options.hoaContext || null;
    const userIdStr = toIdString(userId);
    const trimmedSearch = String(searchText || '').trim();

    const user = options.user || await User.findById(userId)
      .select('_id companyId companyRoleId propertyIds associatedHoaIds')
      .lean();
    if (!user) {
      throw new Error('User not found');
    }

    const roleName = options.roleName
      ? String(options.roleName).toLowerCase()
      : (await resolveUserRoleName(user, { company: options.authCompany }))?.toLowerCase();
    const isVendorUser = isVendorRole(roleName);

    // Non-vendors still require a community scope.
    if (!hoaId && !isVendorUser) {
      return [];
    }

    const includeVendorEmailCommunity = isVendorUser && wantsVendorEmailCommunityContacts(options);
    const isHOAOwner = Boolean(
      hoaContext?.isHOAOwner || isHOAOwnerRole(roleName)
    );
    const cacheKey = `${userIdStr}:${hoaId || 'none'}:${options.maintenanceRequestId || ''}:${Boolean(hoaContext?.isHOABoardMember)}:${isHOAOwner}:${isVendorUser ? 'vendor' : 'member'}:${includeVendorEmailCommunity ? 'email' : 'msg'}`;

    const cached = _contactsResultCache.get(cacheKey);
    let contacts;
    if (cached && (Date.now() - cached.ts) < CONTACTS_RESULT_CACHE_TTL_MS) {
      contacts = cached.contacts;
    } else {
      const boardMemberIds = hoaId
        ? (hoaContext?.hoaMemberUserIds?.length
          ? hoaContext.hoaMemberUserIds.map(toIdString).filter(Boolean)
          : await loadHoaMemberUserIds(hoaId))
        : [];
      const boardMemberIdSet = new Set(boardMemberIds);
      const isHOABoardMember = hoaContext?.isHOABoardMember ?? boardMemberIdSet.has(userIdStr);
      // Owners get the same vendor email/chat roster as board members.
      const canContactHoaVendors = isHOABoardMember || isHOAOwner;

      const contactIds = new Set();
      const hasTicketScope = Boolean(options?.maintenanceRequestId);

      // Vendors messaging stay ticket-scoped; email compose includes community board/owners.
      if (!isVendorUser) {
        boardMemberIds.forEach((memberId) => {
          if (memberId && memberId !== userIdStr) {
            contactIds.add(memberId);
          }
        });
      }

      const scopedOwnerPropertyIds = Array.isArray(hoaContext?.ownerPropertyIds)
        ? hoaContext.ownerPropertyIds.filter(Boolean)
        : (Array.isArray(user.propertyIds) ? user.propertyIds.filter(Boolean) : []);

      const propertyOwnerData = hoaId
        ? await loadHoaPropertyOwnerData(hoaId)
        : { associatedOwnerIds: [], propertyIds: [], propertiesByOwnerId: {}, propertiesById: {} };
      const parallelTasks = [];

      const vendorHoaIds = (() => {
        const fromContext = Array.isArray(hoaContext?.associatedHoaIds)
          ? hoaContext.associatedHoaIds.map(toIdString).filter(Boolean)
          : [];
        const fromUser = Array.isArray(user.associatedHoaIds)
          ? user.associatedHoaIds.map(toIdString).filter(Boolean)
          : [];
        const ids = [...new Set([...(hoaId ? [toIdString(hoaId)] : []), ...fromContext, ...fromUser].filter(Boolean))];
        return ids;
      })();

      // Merge property maps across all vendor-associated HOAs for email compose labels.
      let mergedPropertyOwnerData = {
        associatedOwnerIds: [...(propertyOwnerData.associatedOwnerIds || [])],
        propertyIds: [...(propertyOwnerData.propertyIds || [])],
        propertiesByOwnerId: { ...(propertyOwnerData.propertiesByOwnerId || {}) },
        propertiesById: { ...(propertyOwnerData.propertiesById || {}) },
      };

      if (isHOABoardMember) {
        parallelTasks.push((async () => {
          const ownerRoleFilter = await buildHOAOwnerUserFilter();
          (propertyOwnerData.associatedOwnerIds || []).forEach((ownerId) => {
            if (ownerId !== userIdStr) contactIds.add(ownerId);
          });
          const ownerScope = buildHoaOwnerUserFilter({ hoaId, propertyIds: propertyOwnerData.propertyIds });
          if (!ownerScope) return;
          const scopedOwners = await User.find({
            $and: [
              ownerRoleFilter,
              ownerScope,
              { isDeleted: { $ne: true } },
              activeUserStatusFilter(),
            ],
          })
            .select('_id')
            .lean();
          scopedOwners.forEach((owner) => {
            const ownerId = toIdString(owner._id);
            if (ownerId && ownerId !== userIdStr) contactIds.add(ownerId);
          });
        })());
      } else if (isVendorUser && hasTicketScope) {
        parallelTasks.push((async () => {
          try {
            // Ticket id + assignment is enough; do not require active hoaId match.
            const ticket = await MaintenanceRequest.findOne({
              _id: options.maintenanceRequestId,
              isDeleted: { $ne: true },
              assignedTo: userId,
            })
              .select('createdBy requestedBy')
              .lean();
            if (!ticket) return;

            collectVendorMaintenanceContactIds({
              ticket,
              vendorUserId: userIdStr,
            }).forEach((id) => contactIds.add(id));
          } catch (_) {
            // Keep vendor chat usable even if ticket lookup fails.
          }
        })());
      } else if (isVendorUser) {
        parallelTasks.push((async () => {
          try {
            const ticketQuery = {
              assignedTo: userId,
              isDeleted: { $ne: true },
            };
            if (vendorHoaIds.length) ticketQuery.hoaId = { $in: vendorHoaIds };
            const tickets = await MaintenanceRequest.find(ticketQuery)
              .select('createdBy requestedBy')
              .limit(200)
              .lean();
            tickets.forEach((ticket) => {
              collectVendorMaintenanceContactIds({
                ticket,
                vendorUserId: userIdStr,
              }).forEach((id) => contactIds.add(id));
            });
          } catch (_) {
            // Assigned-ticket party lookup is best-effort.
          }
        })());

        // Prior direct-message partners so existing vendor chats stay in New Message / list.
        parallelTasks.push((async () => {
          try {
            const Message = require('../../shared/messaging/model/message.model');
            const mongoose = require('mongoose');
            if (!mongoose.Types.ObjectId.isValid(userIdStr) || userIdStr.length !== 24) return;
            const vendorOid = new mongoose.Types.ObjectId(userIdStr);
            const partnerRows = await Message.aggregate([
              {
                $match: {
                  isDeleted: { $ne: true },
                  groupId: null,
                  $or: [{ senderId: vendorOid }, { receiverId: vendorOid }],
                },
              },
              {
                $project: {
                  partnerId: {
                    $cond: [
                      { $eq: ['$senderId', vendorOid] },
                      '$receiverId',
                      '$senderId',
                    ],
                  },
                },
              },
              { $group: { _id: '$partnerId' } },
              { $limit: 200 },
            ]);
            partnerRows.forEach((row) => {
              const id = toIdString(row._id);
              if (id && id !== userIdStr) contactIds.add(id);
            });
          } catch (_) {
            /* prior-message partner lookup is best-effort */
          }
        })());
      }

      if (!isVendorUser && !isHOABoardMember) {
        parallelTasks.push(
          Property.find({
            hoaId,
            isDeleted: { $ne: true },
            $or: [
              ...(scopedOwnerPropertyIds.length ? [{ _id: { $in: scopedOwnerPropertyIds } }] : []),
              { associatedOwnerIds: userId },
            ],
          })
            .select('associatedOwnerIds')
            .lean()
            .then((propertiesWithOwner) => {
              propertiesWithOwner.forEach((property) => {
                (property.associatedOwnerIds || []).forEach((ownerId) => {
                  const id = toIdString(ownerId);
                  if (id && id !== userIdStr) contactIds.add(id);
                });
              });
            })
        );
      }

      // Vendor Email compose: include associated HOA board members + property owners.
      // Run before Promise.all so property-map merges stay race-free.
      if (includeVendorEmailCommunity) {
        const communityIds = await collectVendorEmailCommunityContactIds(vendorHoaIds, userIdStr);
        communityIds.forEach((id) => contactIds.add(id));

        await Promise.all(
          vendorHoaIds.map(async (communityHoaId) => {
            if (!communityHoaId) return;
            try {
              const [memberIds, propertyData] = await Promise.all([
                loadHoaMemberUserIds(communityHoaId),
                loadHoaPropertyOwnerData(communityHoaId),
              ]);
              (memberIds || []).forEach((memberId) => {
                const id = toIdString(memberId);
                if (id) boardMemberIdSet.add(id);
              });
              mergedPropertyOwnerData = mergePropertyOwnerMaps(mergedPropertyOwnerData, propertyData);
            } catch (_) {
              /* best-effort community enrichment */
            }
          })
        );
      }

      await Promise.all(parallelTasks);

      const userQueryPromise = contactIds.size > 0
        ? User.find({
          _id: { $in: Array.from(contactIds) },
          isDeleted: { $ne: true },
          ...activeUserStatusFilter(),
        })
          .select('firstName lastName email phone companyId companyRoleId propertyIds')
          .limit(200)
          .lean()
        : Promise.resolve([]);

      const vendorQueryPromise = canContactHoaVendors
        ? (async () => {
          try {
            const vendorRoleFilter = await buildVendorUserFilter({
              isDeleted: { $ne: true },
              ...activeUserStatusFilter(),
            });
            const vendorAssociation = buildVendorHoaAssociationFilter(hoaId);
            const vendorFilter = { ...vendorRoleFilter };
            if (vendorAssociation) {
              vendorFilter.$and = (vendorFilter.$and || []).concat([vendorAssociation]);
            }
            return User.find(vendorFilter)
              .select('firstName lastName email phone propertyIds')
              .limit(100)
              .lean();
          } catch (_) {
            return [];
          }
        })()
        : Promise.resolve([]);

      const [users, vendors] = await Promise.all([userQueryPromise, vendorQueryPromise]);

      if (isVendorUser && users.length) {
        // Resolve requester roles so owners/tenants/landlords/PMs label correctly.
        contacts = await Promise.all(users.map(async (contact) => {
          const resolvedRole = await resolveUserRoleName(contact);
          if (isVendorRole(resolvedRole)) return null;
          return mapUserToContact(
            { ...contact, type: contactTypeFromRoleName(resolvedRole) },
            boardMemberIdSet
          );
        }));
        contacts = contacts.filter(Boolean);
      } else {
        contacts = users.map((contact) => mapUserToContact(contact, boardMemberIdSet));
      }

      if (vendors.length) {
        const existingIds = new Set(contacts.map((c) => toIdString(c.id || c._id)));
        vendors.forEach((vendor) => {
          const id = toIdString(vendor._id);
          if (!id || id === userIdStr || existingIds.has(id) || !vendor.email) return;
          existingIds.add(id);
          contacts.push(mapUserToContact({ ...vendor, type: 'vendor' }, boardMemberIdSet));
        });
      }

      contacts = attachPropertiesToContacts(
        contacts,
        mergedPropertyOwnerData.propertiesByOwnerId || {},
        mergedPropertyOwnerData.propertiesById || {}
      );

      _contactsResultCache.set(cacheKey, { contacts, ts: Date.now() });
    }

    if (trimmedSearch) {
      return contacts.filter((contact) => contactMatchesSearch(contact, trimmedSearch));
    }
    return contacts;
  }

  /**
   * Ensure every recipient email belongs to an allowed active contact.
   * @param {string} userId
   * @param {string|string[]} recipientField - comma-separated or array of emails
   * @param {Object} options - same options as getContacts (hoaId, isHOA, etc.)
   */
  async assertCanEmailRecipients(userId, recipientField, options = {}) {
    const emails = String(recipientField || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (!emails.length) return;

    const opts = {
      ...options,
      contactPurpose: options.contactPurpose || 'email',
    };

    const user = opts.user || await User.findById(userId)
      .select('companyId companyRoleId hoaInfo propertyIds associatedHoaIds')
      .lean();
    const roleName = opts.roleName
      ? String(opts.roleName).toLowerCase()
      : (await resolveUserRoleName(user || {}, { company: opts.authCompany }))?.toLowerCase();

    // Vendors may add freeform valid emails in Compose (BUG-003).
    if (isVendorRole(roleName)) {
      const invalid = emails.filter((email) => !isValidEmail(email));
      if (invalid.length) {
        const err = new Error('Enter a valid email address for each recipient');
        err.status = 400;
        throw err;
      }
      return;
    }

    const contacts = await this.getContacts(userId, '', { ...opts, user, roleName });
    const allowedEmails = new Set(
      contacts
        .map((c) => String(c.email || '').trim().toLowerCase())
        .filter(Boolean)
    );

    const disallowed = emails.filter((email) => !allowedEmails.has(email));
    if (disallowed.length) {
      const err = new Error('You are not allowed to email inactive or unauthorized recipients');
      err.status = 403;
      throw err;
    }
  }
}

module.exports = new ContactsService();
module.exports.buildContactsOptionsFromRequest = buildContactsOptionsFromRequest;
module.exports.invalidateContactsCaches = invalidateContactsCaches;
module.exports.collectVendorMaintenanceContactIds = collectVendorMaintenanceContactIds;
module.exports.wantsVendorEmailCommunityContacts = wantsVendorEmailCommunityContacts;
module.exports.collectVendorEmailCommunityContactIds = collectVendorEmailCommunityContactIds;
