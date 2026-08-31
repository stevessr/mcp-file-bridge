import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const MANIFEST_SUFFIX = '.json';
const PART_SUFFIX = '.part';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest();
}

function assertSha256(value, field = 'sha256') {
  if (value == null || value === '') return undefined;
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${field} must be a 64-character hex SHA-256 digest`);
  return value.toLowerCase();
}

export function normalizeRelativePath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path must be a non-empty string');
  if (input.includes('\0')) throw new Error('path contains NUL');
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) throw new Error('path traversal is not allowed');
  return parts.join('/');
}

function resolveInside(root, rel) {
  const normalized = normalizeRelativePath(rel);
  const target = path.resolve(root, normalized);
  const rootResolved = path.resolve(root) + path.sep;
  if (!target.startsWith(rootResolved)) throw new Error('resolved path escapes storage root');
  return { normalized, target };
}

export class UploadStore {
  constructor({ dataDir, maxFileBytes = 10 * 1024 * 1024 * 1024 }) {
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, 'files');
    this.uploadsDir = path.join(this.dataDir, '.uploads');
    this.maxFileBytes = maxFileBytes;
  }

  async init() {
    await mkdir(this.filesDir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
  }

  manifestPath(uploadId) {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error('invalid upload_id');
    return path.join(this.uploadsDir, `${uploadId}${MANIFEST_SUFFIX}`);
  }

  partPath(uploadId) {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error('invalid upload_id');
    return path.join(this.uploadsDir, `${uploadId}${PART_SUFFIX}`);
  }

  async readManifest(uploadId) {
    return JSON.parse(await readFile(this.manifestPath(uploadId), 'utf8'));
  }

  async writeManifest(manifest) {
    await writeFile(this.manifestPath(manifest.upload_id), JSON.stringify(manifest, null, 2));
  }

  async createUpload({ relativePath, sizeBytes, sha256, ttlSeconds = 900 }) {
    const { normalized, target } = resolveInside(this.filesDir, relativePath);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('size_bytes must be a non-negative safe integer');
    if (sizeBytes > this.maxFileBytes) throw new Error(`file exceeds MAX_FILE_BYTES (${this.maxFileBytes})`);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) throw new Error('ttl_seconds must be between 60 and 86400');
    try {
      await stat(target);
      throw new Error(`destination already exists: ${normalized}`);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const uploadId = randomUUID();
    const uploadToken = randomBytes(32).toString('base64url');
    const expectedSha256 = assertSha256(sha256);
    const now = Date.now();
    const manifest = {
      upload_id: uploadId,
      relative_path: normalized,
      size_bytes: sizeBytes,
      sha256: expectedSha256 ?? null,
      token_sha256: sha256Text(uploadToken).toString('hex'),
      status: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlSeconds * 1000).toISOString()
    };
    await this.writeManifest(manifest);
    return { manifest, uploadToken };
  }

  verifyToken(manifest, token) {
    if (typeof token !== 'string' || token.length < 16) return false;
    const expected = Buffer.from(manifest.token_sha256, 'hex');
    const actual = sha256Text(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async receiveStream({ uploadId, token, stream, contentLength }) {
    const manifest = await this.readManifest(uploadId);
    if (manifest.status !== 'pending') throw new Error(`upload is ${manifest.status}`);
    if (Date.now() > Date.parse(manifest.expires_at)) throw new Error('upload token has expired');
    if (!this.verifyToken(manifest, token)) throw new Error('invalid upload token');
    if (contentLength != null && contentLength !== manifest.size_bytes) {
      throw new Error(`content-length mismatch: expected ${manifest.size_bytes}, got ${contentLength}`);
    }

    const part = this.partPath(uploadId);
    await rm(part, { force: true });
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > manifest.size_bytes) return callback(new Error('request body exceeds declared file size'));
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    try {
      await pipeline(stream, meter, createWriteStream(part, { flags: 'wx' }));
      if (received !== manifest.size_bytes) throw new Error(`upload incomplete: received ${received}/${manifest.size_bytes} bytes`);
      const actualSha256 = hash.digest('hex');
      if (manifest.sha256 && actualSha256 !== manifest.sha256) {
        throw new Error(`sha256 mismatch: expected ${manifest.sha256}, got ${actualSha256}`);
      }

      const { normalized, target } = resolveInside(this.filesDir, manifest.relative_path);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await stat(target);
        throw new Error(`destination already exists: ${normalized}`);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      await rename(part, target);
      manifest.status = 'completed';
      manifest.received_bytes = received;
      manifest.actual_sha256 = actualSha256;
      manifest.completed_at = new Date().toISOString();
      delete manifest.token_sha256;
      await this.writeManifest(manifest);
      return { path: normalized, size_bytes: received, sha256: actualSha256 };
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
  }

  async receiveProvidedStream({ relativePath, stream, contentLength, expectedSha256 }) {
    const { normalized, target } = resolveInside(this.filesDir, relativePath);
    const expected = assertSha256(expectedSha256);
    if (contentLength != null) {
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error('invalid content length');
      if (contentLength > this.maxFileBytes) throw new Error(`file exceeds MAX_FILE_BYTES (${this.maxFileBytes})`);
    }
    try {
      await stat(target);
      throw new Error(`destination already exists: ${normalized}`);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const part = path.join(this.uploadsDir, `${randomUUID()}${PART_SUFFIX}`);
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > this.maxFileBytes) return callback(new Error(`file exceeds MAX_FILE_BYTES (${this.maxFileBytes})`));
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    meter.maxFileBytes = this.maxFileBytes;

    try {
      await pipeline(stream, meter, createWriteStream(part, { flags: 'wx' }));
      if (contentLength != null && received !== contentLength) {
        throw new Error(`download incomplete: received ${received}/${contentLength} bytes`);
      }
      const actualSha256 = hash.digest('hex');
      if (expected && actualSha256 !== expected) {
        throw new Error(`sha256 mismatch: expected ${expected}, got ${actualSha256}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await stat(target);
        throw new Error(`destination already exists: ${normalized}`);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      await rename(part, target);
      return { path: normalized, size_bytes: received, sha256: actualSha256 };
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
  }

  async uploadInfo(uploadId) {
    const manifest = await this.readManifest(uploadId);
    const { token_sha256: _secret, ...safe } = manifest;
    return safe;
  }

  async cancel(uploadId) {
    const manifest = await this.readManifest(uploadId);
    if (manifest.status === 'completed') throw new Error('completed upload cannot be cancelled');
    await rm(this.partPath(uploadId), { force: true });
    manifest.status = 'cancelled';
    delete manifest.token_sha256;
    manifest.cancelled_at = new Date().toISOString();
    await this.writeManifest(manifest);
    return { upload_id: uploadId, cancelled: true };
  }

  async fileInfo(relativePath) {
    const { normalized, target } = resolveInside(this.filesDir, relativePath);
    const s = await stat(target);
    if (!s.isFile()) throw new Error('path is not a file');
    return { path: normalized, size_bytes: s.size, sha256: await sha256File(target), modified_at: s.mtime.toISOString() };
  }

  async list(prefix = '') {
    let base = this.filesDir;
    let normalizedPrefix = '';
    if (prefix) {
      const resolved = resolveInside(this.filesDir, prefix);
      base = resolved.target;
      normalizedPrefix = resolved.normalized;
    }
    async function walk(dir, relBase = '') {
      const entries = await readdir(dir, { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full, rel));
        else if (entry.isFile()) {
          const s = await stat(full);
          out.push({ path: normalizedPrefix ? `${normalizedPrefix}/${rel}` : rel, size_bytes: s.size, modified_at: s.mtime.toISOString() });
        }
      }
      return out;
    }
    try {
      const s = await stat(base);
      if (s.isFile()) return [await this.fileInfo(prefix)];
      return await walk(base);
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  async delete(relativePath) {
    const { normalized, target } = resolveInside(this.filesDir, relativePath);
    const s = await stat(target);
    if (!s.isFile()) throw new Error('path is not a file');
    await rm(target);
    return { path: normalized, deleted: true };
  }
}
