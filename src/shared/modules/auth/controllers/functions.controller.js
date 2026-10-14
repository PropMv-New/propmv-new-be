/**
 * ------------------------------------------------------------------
 * File: functions.controller.js
 * Module: Src Shared Modules Auth Controllers
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * functions.routes
 * ------------------------------------------------------------------
 */

const functionsService = require('../services/functions.service');

async function listFunctions(req, res) {
  try {
    const items = await functionsService.listFunctions();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getFunctionById(req, res) {
  try {
    const item = await functionsService.getFunctionById(req.params.id);
    res.json(item);
  } catch (err) {
    res.status(404).json({ message: 'Function not found' });
  }
}

async function createFunction(req, res) {
  try {
    const { name, description } = req.body;
    const created = await functionsService.createFunction({ name, description });
    res.status(201).json(created);
  } catch (err) {
    const status = err.message === 'Function already exists' ? 409 : 400;
    res.status(status).json({ message: err.message });
  }
}

async function updateFunction(req, res) {
  try {
    const { name, description } = req.body;
    const updated = await functionsService.updateFunction(req.params.id, { name, description });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

async function deleteFunction(req, res) {
  try {
    await functionsService.deleteFunction(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(err.message.includes('in use') ? 400 : 404).json({ message: err.message });
  }
}

module.exports = {
  listFunctions,
  getFunctionById,
  createFunction,
  updateFunction,
  deleteFunction,
};


