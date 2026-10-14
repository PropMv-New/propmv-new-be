/**
 * Reported: chat attachments could not be opened or downloaded, on the Owner
 * and the Board side. Chat saved each file's plain storage URL, which a
 * private bucket refuses. The controller now hands the conversation's members
 * a short-lived signed link, and nobody else.
 */
const { test, beforeEach, afterEach } = require('node:test');
const { Readable, Writable } = require('node:stream');
const assert = require('node:assert/strict');
const Message = require('../../model/message.model');
const GroupChat = require('../../model/groupChat.model');
const storageClient = require('../../../../integrations/storage');
const controller = require('../message.controller');

const saved = {};
let presignedKeys;

const directMessage = {
  _id: 'm1',
  senderId: 'owner1',
  receiverId: 'board1',
  groupId: null,
  attachments: [{
    originalName: 'Screenshot 2026.png',
    mimeType: 'image/png',
    url: 'https://bucket.s3.us-east-1.amazonaws.com/Messaging/owner1/1700-Screenshot%202026.png',
  }],
};

function mockFind(doc) {
  Message.findById = () => ({ select: () => ({ lean: async () => doc }) });
}

function run(userId, params = { messageId: 'm1', index: '0' }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    controller.getAttachmentUrl({ params, userId }, res, reject);
  });
}

beforeEach(() => {
  saved.findById = Message.findById;
  saved.exists = GroupChat.exists;
  saved.presign = storageClient.getPresignedUrl;
  presignedKeys = [];
  storageClient.getPresignedUrl = async ({ key }) => {
    presignedKeys.push(key);
    return `https://signed.example/${key}`;
  };
});

afterEach(() => {
  Message.findById = saved.findById;
  GroupChat.exists = saved.exists;
  storageClient.getPresignedUrl = saved.presign;
});

test('the receiver gets a signed link for the stored object', async () => {
  mockFind(directMessage);
  const { status, body } = await run('board1');
  assert.equal(status, 200);
  assert.deepEqual(presignedKeys, ['Messaging/owner1/1700-Screenshot 2026.png']);
  assert.equal(body.data.originalName, 'Screenshot 2026.png');
});

test('someone outside the conversation is refused', async () => {
  mockFind(directMessage);
  const { status } = await run('stranger');
  assert.equal(status, 403);
  assert.equal(presignedKeys.length, 0);
});

test('a group member gets a link', async () => {
  mockFind({ ...directMessage, receiverId: null, groupId: 'g1' });
  GroupChat.exists = async (q) => (q['members.userId'] === 'member2' ? { _id: 'g1' } : null);
  const { status } = await run('member2');
  assert.equal(status, 200);
});

test('a missing attachment index is a 404', async () => {
  mockFind(directMessage);
  const { status } = await run('owner1', { messageId: 'm1', index: '3' });
  assert.equal(status, 404);
});

function stream(userId, params = { messageId: 'm1', index: '0' }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const headers = {};
    const res = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => resolve({ status: res.statusCode, body });
    res.on('finish', () => resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks).toString() }));
    controller.streamAttachment({ params, userId }, res, reject);
  });
}

test('the file route streams the stored object to a member', async () => {
  mockFind(directMessage);
  const read = [];
  const saveStream = storageClient.getStream;
  storageClient.getStream = async ({ key }) => { read.push(key); return Readable.from(['PNGDATA']); };
  try {
    const { status, headers, body } = await stream('board1');
    assert.equal(status, 200);
    assert.deepEqual(read, ['Messaging/owner1/1700-Screenshot 2026.png']);
    assert.equal(body, 'PNGDATA');
    assert.equal(headers['content-type'], 'image/png');
    assert.match(headers['content-disposition'], /filename\*=UTF-8''Screenshot%202026\.png/);
  } finally {
    storageClient.getStream = saveStream;
  }
});

test('the file route refuses someone outside the conversation', async () => {
  mockFind(directMessage);
  const { status } = await stream('stranger');
  assert.equal(status, 403);
});

test('mock storage paths resolve to their key', async () => {
  const saveBase = storageClient.baseUrl;
  const saveStream = storageClient.getStream;
  const read = [];
  storageClient.baseUrl = '/mock-s3';
  storageClient.getStream = async ({ key }) => { read.push(key); return Readable.from(['x']); };
  mockFind({ ...directMessage, attachments: [{ ...directMessage.attachments[0], url: '/mock-s3/Messaging/owner1/a.png' }] });
  try {
    const { status } = await stream('owner1');
    assert.equal(status, 200);
    assert.deepEqual(read, ['Messaging/owner1/a.png']);
  } finally {
    storageClient.baseUrl = saveBase;
    storageClient.getStream = saveStream;
  }
});

