/**
 * ------------------------------------------------------------------
 * File: masterData.controller.js
 * Module: Src Shared Modules Master Controller
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * masterData.routes
 * ------------------------------------------------------------------
 */

const masterDataService = require('../service/masterData.service');
const mongoose = require('mongoose');

const createMasterData = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const data = await masterDataService.createMasterData(req.body, { session });
    await session.commitTransaction();
    session.endSession();
    res.status(201).json(data);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ error: err.message });
  }
};

const getMasterDataById = async (req, res) => {
  try {
    const data = await masterDataService.getMasterDataById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Fetched successfully', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateMasterData = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const updated = await masterDataService.updateMasterData(req.params.id, req.body, { session });
    await session.commitTransaction();
    session.endSession();
    res.json({ message: 'Updated successfully', data: updated });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ error: err.message });
  }
};

const deleteMasterData = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await masterDataService.deleteMasterData(req.params.id, { session });
    await session.commitTransaction();
    session.endSession();
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ error: err.message });
  }
};

const listMasterData = async (req, res) => {
  try {
    const data = await masterDataService.listMasterData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getMasterData = async (req, res) => {
  try {
    let keys = req.query.keys;
    if (!keys) keys = [];
    if (!Array.isArray(keys)) keys = [keys];
    const data = await masterDataService.getMasterDataByKeys(keys);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createMasterData,
  getMasterDataById,
  updateMasterData,
  deleteMasterData,
  listMasterData,
  getMasterData,
};
