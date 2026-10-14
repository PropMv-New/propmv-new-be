const { createReferLeadService } = require('../service/referLead.service');
const { wrapController } = require('../../../../../common/helpers/asyncHandler');

const createReferLead = async (req, res) => {
  const userId     = req.user.id;
  const landlordId = req.user.id;
  try {
    const record = await createReferLeadService(userId, landlordId, req.body);
    return res.status(201).json(record);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return res.status(err.status).json({ message: err.message });
    }
    if (err.status === 422) {
      return res.status(422).json({
        message: err.message,
        errors:  err.steadilyErrors || null,
      });
    }
    throw err;
  }
};

module.exports = wrapController({ createReferLead });
