const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../../../../../shared/modules/users/models/user.model');
const { assignVendorRoleFields, buildVendorUserFilter, isVendorRole } = require('../../../../../common/helpers/hoaVendorRole');
const { USER_STATUSES } = require('../../../../../common/constants/user');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { collectVendorAssociatedHoaIds } = require('../../../../../middleware/hoaDataIsolation');
const logger = require('../../../../../common/logger');

const MODULE = 'vendor-service';



function toIdString(id) {

  if (!id) return '';

  return id.toString ? id.toString() : String(id);

}



function vendorBelongsToHoa(user, hoaId) {

  if (!hoaId) return true;

  return collectVendorAssociatedHoaIds(user).includes(toIdString(hoaId));

}



async function createVendor(payload, actorId, hoaContext = null) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) {
    const err = new Error('Email is required');
    err.status = 400;
    throw err;
  }

  const existing = await User.findOne({ email, isDeleted: { $ne: true } }).select('_id').lean();
  if (existing) {
    const err = new Error('A user with this email already exists');
    err.status = 409;
    throw err;
  }

  const hoaId = payload.hoaId || hoaContext?.hoaId || null;
  const shouldSendInvite = payload.sendInvite !== false && !payload.password;

  const tempPassword = payload.password
    ? String(payload.password)
    : crypto.randomBytes(12).toString('base64url');
  const hashed = await bcrypt.hash(tempPassword, 10);

  const userFields = {
    email,
    password: hashed,
    firstName: String(payload.firstName || '').trim(),
    lastName: String(payload.lastName || '').trim(),
    phone: String(payload.phone || '').trim() || undefined,
    status: payload.password ? USER_STATUSES.ACTIVE : USER_STATUSES.PENDING,
    portalOnboardingStatus: payload.password
      ? PORTAL_ONBOARDING_STATUS.ACTIVE
      : PORTAL_ONBOARDING_STATUS.INVITATION_SENT,
    sendInvite: shouldSendInvite && Boolean(email),
    associatedHoaIds: hoaId ? [hoaId] : [],
    createdBy: actorId,
    hoaBoardMemberId: actorId,
  };

  await assignVendorRoleFields(userFields);
  const user = await User.create(userFields);
  logger.info('Vendor user created', { module: MODULE, action: 'createVendor' });

  return {
    user: await formatVendor(user.toObject ? user.toObject() : user),
    temporaryPassword: payload.password ? undefined : tempPassword,
    sendInvite: shouldSendInvite && Boolean(email),
  };
}



async function formatVendor(user) {

  const associatedHoaIds = collectVendorAssociatedHoaIds(user);

  return {

    id: user._id,

    _id: user._id,

    firstName: user.firstName || '',

    lastName: user.lastName || '',

    name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,

    email: user.email,

    phone: user.phone || '',

    hoaId: associatedHoaIds[0] || null,

    associatedHoaIds,

    status: user.status,

    portalOnboardingStatus: user.portalOnboardingStatus || null,

    createdAt: user.createdAt,

  };

}



async function listVendors(query = {}, hoaContext = null) {

  const roleFilter = await buildVendorUserFilter({ isDeleted: { $ne: true } });

  const filter = { ...roleFilter };



  if (query.searchText) {

    const text = String(query.searchText).trim();

    if (text) {

      filter.$and = (filter.$and || []).concat([{

        $or: [

          { firstName: { $regex: text, $options: 'i' } },

          { lastName: { $regex: text, $options: 'i' } },

          { email: { $regex: text, $options: 'i' } },

        ],

      }]);

    }

  }



  const { offset, limit, page, pageSize } = getPagination({

    page: query.pageNumber || query.page,

    pageSize: query.pageSize,

  });



  const [rows, total] = await Promise.all([

    User.find(filter)

      .select('firstName lastName email phone hoaInfo associatedHoaIds status portalOnboardingStatus createdAt')

      .sort({ createdAt: -1 })

      .skip(offset)

      .limit(limit)

      .lean(),

    User.countDocuments(filter),

  ]);



  return {

    data: await Promise.all(rows.map(formatVendor)),

    total,

    page,

    pageSize,

  };

}



async function getVendorById(id, hoaContext = null) {

  const roleFilter = await buildVendorUserFilter({ _id: id, isDeleted: { $ne: true } });

  const user = await User.findOne(roleFilter)

    .select('firstName lastName email phone hoaInfo associatedHoaIds status portalOnboardingStatus createdAt')

    .lean();



  if (!user) {

    const err = new Error('Vendor not found');

    err.status = 404;

    throw err;

  }



  return formatVendor(user);

}



async function updateVendor(id, payload, hoaContext = null) {

  const user = await User.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!user) {

    const err = new Error('Vendor not found');

    err.status = 404;

    throw err;

  }



  if (payload.firstName != null) user.firstName = String(payload.firstName).trim();

  if (payload.lastName != null) user.lastName = String(payload.lastName).trim();

  if (payload.phone != null) user.phone = String(payload.phone).trim();

  if (payload.status != null) user.status = payload.status;



  await user.save();

  return formatVendor(user.toObject());

}



async function deleteVendor(id, hoaContext = null) {

  const user = await User.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!user) {

    const err = new Error('Vendor not found');

    err.status = 404;

    throw err;

  }



  user.isDeleted = true;
  user.status = USER_STATUSES.INACTIVE;
  await user.save();
  logger.info('Vendor soft-deleted', { module: MODULE, action: 'deleteVendor' });
  return true;

}



module.exports = {

  createVendor,

  listVendors,

  getVendorById,

  updateVendor,

  deleteVendor,

  isVendorRole,

};


