/**
 * ------------------------------------------------------------------
 * File: event.controller.js
 * Module: Events Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * event.routes
 * ------------------------------------------------------------------
 */

const service = require('../service/event.service');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');

const createEvent = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'createEvent' });
  try {
    const result = await service.createEvent(req.body);
    return res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
};

const getEvents = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getEvents' });
  try {
    const result = await service.getEvents(req.query);
    return res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
};

const getEventById = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getEventById' });
  try {
    const result = await service.getEventById(req.params.id);
    return res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
};

const updateEvent = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'updateEvent' });
  try {
    const result = await service.updateEvent(req.params.id, req.body);
    return res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
};

const deleteEvent = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'deleteEvent' });
  try {
    const result = await service.deleteEvent(req.params.id);
    return res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent
};
