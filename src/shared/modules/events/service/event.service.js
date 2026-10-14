/**
 * ------------------------------------------------------------------
 * File: event.service.js
 * Module: Events Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * event.controller
 * ------------------------------------------------------------------
 */

const Event = require('../model/event.model');
const mongoose = require('mongoose');
const { DateUtil } = require('../../../../common/date');

/**
 * Build query filter from request parameters
 * @param {Object} params - Query parameters
 * @returns {Object} MongoDB filter object
 */
function buildEventFilter(params) {
  const { event, from, to, notificationDate, propertyId, unit } = params;
  const filter = {};

  if (event) filter.event = event;
  if (from && mongoose.Types.ObjectId.isValid(from)) filter.from = from;
  if (to && mongoose.Types.ObjectId.isValid(to)) filter.to = to;
  if (notificationDate) filter.notificationDate = DateUtil.toUTC(notificationDate);
  if (propertyId && mongoose.Types.ObjectId.isValid(propertyId)) filter.propertyId = propertyId;
  if (unit) filter.unit = unit;

  return filter;
}

/**
 * Create a new event
 * @param {Object} data - Event data
 * @returns {Promise<Object>} Created event with status
 */
const createEvent = async (data) => {
  const event = new Event(data);
  const saved = await event.save();
  return { status: 201, data: saved };
};

/**
 * Get events with optional filters and pagination
 * @param {Object} params - Query parameters including filters and pagination
 * @returns {Promise<Object>} Events list with metadata
 */
const getEvents = async (params) => {
  const { page = 1, limit = 20 } = params;
  
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * limitNum;

  const filter = buildEventFilter(params);

  const [events, total] = await Promise.all([
    Event.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Event.countDocuments(filter)
  ]);

  return {
    status: 200,
    data: {
      data: events,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    }
  };
};

/**
 * Get event by ID
 * @param {string} id - Event ID
 * @returns {Promise<Object>} Event data
 */
const getEventById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error('Invalid event ID');
    error.status = 400;
    throw error;
  }

  const event = await Event.findById(id).lean();
  if (!event) {
    const error = new Error('Event not found');
    error.status = 404;
    throw error;
  }
  return { status: 200, data: event };
};

/**
 * Update an existing event
 * @param {string} id - Event ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated event
 */
const updateEvent = async (id, updates) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error('Invalid event ID');
    error.status = 400;
    throw error;
  }

  const event = await Event.findByIdAndUpdate(
    id,
    { $set: updates },
    { new: true, runValidators: true }
  );

  if (!event) {
    const error = new Error('Event not found');
    error.status = 404;
    throw error;
  }

  return { status: 200, data: event };
};

/**
 * Delete an event
 * @param {string} id - Event ID
 * @returns {Promise<Object>} Success message
 */
const deleteEvent = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error('Invalid event ID');
    error.status = 400;
    throw error;
  }

  const event = await Event.findByIdAndDelete(id);
  if (!event) {
    const error = new Error('Event not found');
    error.status = 404;
    throw error;
  }
  return { status: 200, data: { message: 'Event deleted successfully' } };
};

module.exports = {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent
};
