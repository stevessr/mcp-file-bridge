import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeRelativePath, UploadStore } from '../src/storage.mjs';

test('rejects path traversal', () => {
  assert.throws(() => normalizeRelativePath('../secret'));
  assert.throws(() => normalizeRelativePath('a/../../secret'));
  assert.equal(normalizeRelativePath('/builds/app.iso'), 'builds/app.iso');
});

test('streams bytes outside MCP arguments and verifies sha256', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-file-bridge-'));
  try {
    const store = new UploadStore({ dataDir: dir, maxFileBytes: 1024 * 1024 });
    await store.init();
    const payload = Buffer.alloc(256 * 1024, 0x5a);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const { manifest, uploadToken } = await store.createUpload({ relativePath: 'demo/file.bin', sizeBytes: payload.length, sha256 });
    const result = await store.receiveStream({
      uploadId: manifest.upload_id,
      token: uploadToken,
      stream: Readable.from([payload.subarray(0, 100000), payload.subarray(100000)]),
      contentLength: payload.length
    });
    assert.equal(result.sha256, sha256);
    assert.deepEqual(await readFile(path.join(dir, 'files/demo/file.bin')), payload);
    assert.equal((await store.uploadInfo(manifest.upload_id)).status, 'completed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a bad one-time upload token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-file-bridge-'));
  try {
    const store = new UploadStore({ dataDir: dir, maxFileBytes: 1024 });
    await store.init();
    const { manifest } = await store.createUpload({ relativePath: 'x.bin', sizeBytes: 1 });
    await assert.rejects(() => store.receiveStream({ uploadId: manifest.upload_id, token: 'definitely-wrong-token', stream: Readable.from([Buffer.from('x')]), contentLength: 1 }), /invalid upload token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stores a host-provided stream without base64 or MCP chunk arguments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-file-bridge-'));
  try {
    const store = new UploadStore({ dataDir: dir, maxFileBytes: 1024 * 1024 });
    await store.init();
    const payload = Buffer.from('hello from host file bridge');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const result = await store.receiveProvidedStream({
      relativePath: 'host/report.txt',
      stream: Readable.from([payload]),
      contentLength: payload.length,
      expectedSha256: sha256
    });
    assert.equal(result.size_bytes, payload.length);
    assert.equal(result.sha256, sha256);
    assert.deepEqual(await readFile(path.join(dir, 'files/host/report.txt')), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
