/**
 * ------------------------------------------------------------------
 * File: weather.controller.js
 * Module: Users Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * weather.routes
 * ------------------------------------------------------------------
 */

const weatherService = require('../services/weather.service');
const responseHelper = require('../../../../common/helpers/responseHelper');
const logger = require('../../../../common/logger');

const getWeather = async (req, res) => {
  const { address } = req.query;
  try {
    const weatherData = await weatherService.getWeatherForAddress(address);
    return responseHelper.success(res, weatherData, 'Weather data fetched successfully', 200);
  } catch (err) {
    logger.error('Weather API error:', err);
    const statusCode = err.message.includes('not found') ? 404 : 500;
    return responseHelper.error(res, err.message, statusCode);
  }
};

module.exports = {
  getWeather
};
