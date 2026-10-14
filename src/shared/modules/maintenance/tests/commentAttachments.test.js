/**
 * Maintenance comments can carry the ids of files sent with them, so the app
 * can show a comment's photos with the comment instead of only under
 * Attachments & Media. Only documents of the same ticket may be linked.
 *
 * Run: node --test src/shared/modules/maintenance/tests/commentAttachments.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { linkableCommentAttachments } = require('../service/maintenance.service');

const docA = new mongoose.Types.ObjectId();
const docB = new mongoose.Types.ObjectId();
const request = { documents: [{ metadataId: docA }, { metadataId: docB }] };

test('links the ticket documents sent with the comment', () => {
  const linked = linkableCommentAttachments(request, [String(docA), String(docB)]);
  assert.deepEqual(linked.map(String), [String(docA), String(docB)]);
});

test('drops ids that are not documents of this ticket', () => {
  const other = new mongoose.Types.ObjectId();
  const linked = linkableCommentAttachments(request, [String(other), String(docA), 'not-an-id']);
  assert.deepEqual(linked.map(String), [String(docA)]);
});

test('removes duplicates', () => {
  const linked = linkableCommentAttachments(request, [String(docA), String(docA)]);
  assert.equal(linked.length, 1);
});

test('no attachments is an empty list', () => {
  assert.deepEqual(linkableCommentAttachments(request, undefined), []);
  assert.deepEqual(linkableCommentAttachments(request, []), []);
  assert.deepEqual(linkableCommentAttachments({}, [String(docA)]), []);
});
