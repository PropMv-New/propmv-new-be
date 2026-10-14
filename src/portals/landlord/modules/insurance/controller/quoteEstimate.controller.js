/**
 * ------------------------------------------------------------------
 * File: quoteEstimate.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * quoteEstimate.routes
 * ------------------------------------------------------------------
 */

const {
  createQuoteEstimateService,
  getQuoteEstimatesService,
  getQuoteEstimateByIdService,
} = require('../service/quoteEstimate.service');
const { wrapController } = require('../../../../../common/helpers/asyncHandler');

const createQuoteEstimate = async (req, res) => {
  const userId = req.user.id;
  const landlordId = req.user.id;
  try {
    const record = await createQuoteEstimateService(userId, landlordId, req.body);
    return res.status(201).json(record);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return res.status(err.status).json({ message: err.message });
    }
    if (err.status === 422) {
      return res.status(422).json({
        message: err.message,
        errors: err.steadilyErrors || null,
      });
    }
    throw err;
  }
};

const getQuoteEstimates = async (req, res) => {
  const landlordId = req.user.id;
  const result = await getQuoteEstimatesService(landlordId, req.query);
  return res.json(result);
};

const getQuoteEstimateById = async (req, res) => {
  const landlordId = req.user.id;
  const record = await getQuoteEstimateByIdService(landlordId, req.params.id);
  return res.json(record);
};

module.exports = wrapController({
  createQuoteEstimate,
  getQuoteEstimates,
  getQuoteEstimateById,
});
