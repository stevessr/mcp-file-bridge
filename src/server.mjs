import { createServer } from 'node:http';
import process from 'node:process';
import { Readable } from 'node:stream';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { UploadStore } from './storage.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const API_TOKEN = process.env.MCP_API_TOKEN ?? '';
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 10 * 1024 * 1024 * 1024);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const PROVIDED_FILE_HOST_SUFFIXES = (process.env.PROVIDED_FILE_HOST_SUFFIXES ?? 'openai.com,oaiusercontent.com,blob.core.windows.net')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);

if (!Number.isSafeInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error('invalid PORT');
if (!Number.isSafeInteger(MAX_FILE_BYTES) || MAX_FILE_BYTES <= 0) throw new Error('invalid MAX_FILE_BYTES');

const store = new UploadStore({ dataDir: DATA_DIR, maxFileBytes: MAX_FILE_BYTES });
await store.init();

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const failure = (err) => ({ isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] });

const providedFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
});

function hostMatchesSuffix(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function validateProvidedFileUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('provided file URL must use HTTPS');
  if (url.username || url.password) throw new Error('provided file URL must not contain credentials');
  if (url.port && url.port !== '443') throw new Error('provided file URL must use the default HTTPS port');
  const host = url.hostname.toLowerCase();
  if (!PROVIDED_FILE_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))) {
    throw new Error(`provided file host is not allowed: ${host}`);
  }
  return url;
}

async function fetchProvidedFile(rawUrl, maxRedirects = 5) {
  let current = validateProvidedFileUrl(rawUrl);
  for (let i = 0; i <= maxRedirects; i += 1) {
    const response = await fetch(current, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('provided file redirect is missing location');
      current = validateProvidedFileUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`provided file download failed with HTTP ${response.status}`);
    if (!response.body) throw new Error('provided file response has no body');
    return response;
  }
  throw new Error('too many provided file redirects');
}

function defaultDestination(file) {
  const candidate = file.file_name?.trim();
  if (candidate) return candidate;
  const safeId = file.file_id.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `uploads/${safeId || 'file'}.bin`;
}

function factory() {
  const server = new McpServer({ name: 'mcp-file-bridge', version: '0.3.0' });

  server.registerTool('ingest_file', {
    description: 'Import a ChatGPT/Codex host file without putting file bytes or base64 in model context. Compatible hosts bind a local/attached file to this tool through openai/fileParams and send a temporary provided-file object.',
    inputSchema: z.object({
      file: providedFileSchema,
      path: z.string().optional().describe('Destination path relative to storage. Defaults to the provided file name.'),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe('Optional expected SHA-256 for end-to-end integrity checking.')
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    },
    _meta: {
      'openai/fileParams': ['file']
    }
  }, async ({ file, path, sha256 }) => {
    try {
      const destination = path ?? defaultDestination(file);
      const response = await fetchProvidedFile(file.download_url);
      const lengthHeader = response.headers.get('content-length');
      const contentLength = lengthHeader == null ? undefined : Number(lengthHeader);
      if (contentLength != null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
        throw new Error('invalid provided file content-length');
      }
      const result = await store.receiveProvidedStream({
        relativePath: destination,
        stream: Readable.fromWeb(response.body),
        contentLength,
        expectedSha256: sha256
      });
      return text({
        ...result,
        source_file_id: file.file_id,
        source_file_name: file.file_name ?? null,
        mime_type: file.mime_type ?? response.headers.get('content-type') ?? null,
        transfer: 'host-file-parameter'
      });
    } catch (err) { return failure(err); }
  });

  server.registerTool('create_upload', {
    description: 'Create a short-lived direct HTTP upload session. The model only handles metadata; file bytes must be streamed by client-side code to upload_url.',
    inputSchema: z.object({
      path: z.string().describe('Destination path relative to storage, e.g. builds/app.iso'),
      size_bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
      ttl_seconds: z.number().int().min(60).max(86400).optional().default(900)
    })
  }, async ({ path, size_bytes, sha256, ttl_seconds }) => {
    try {
      const { manifest, uploadToken } = await store.createUpload({ relativePath: path, sizeBytes: size_bytes, sha256, ttlSeconds: ttl_seconds });
      return text({
        upload_id: manifest.upload_id,
        upload_url: `${PUBLIC_BASE_URL}/upload/${manifest.upload_id}`,
        upload_token: uploadToken,
        method: 'PUT',
        authorization: 'Bearer <upload_token>',
        size_bytes: manifest.size_bytes,
        expires_at: manifest.expires_at,
        note: 'Stream the file body directly from code. Do not place file bytes/base64 in MCP arguments.'
      });
    } catch (err) { return failure(err); }
  });

  server.registerTool('get_upload', {
    description: 'Get the state of a direct upload session.',
    inputSchema: z.object({ upload_id: z.string().uuid() })
  }, async ({ upload_id }) => {
    try { return text(await store.uploadInfo(upload_id)); }
    catch (err) { return failure(err); }
  });

  server.registerTool('cancel_upload', {
    description: 'Cancel a pending upload session.',
    inputSchema: z.object({ upload_id: z.string().uuid() })
  }, async ({ upload_id }) => {
    try { return text(await store.cancel(upload_id)); }
    catch (err) { return failure(err); }
  });

  server.registerTool('list_files', {
    description: 'List completed files. Optionally restrict to a relative prefix.',
    inputSchema: z.object({ prefix: z.string().optional().default('') })
  }, async ({ prefix }) => {
    try { return text({ files: await store.list(prefix) }); }
    catch (err) { return failure(err); }
  });

  server.registerTool('stat_file', {
    description: 'Return size, modified time, and SHA-256 for one completed file.',
    inputSchema: z.object({ path: z.string() })
  }, async ({ path }) => {
    try { return text(await store.fileInfo(path)); }
    catch (err) { return failure(err); }
  });

  server.registerTool('delete_file', {
    description: 'Delete one completed file. This is destructive.',
    inputSchema: z.object({ path: z.string() })
  }, async ({ path }) => {
    try { return text(await store.delete(path)); }
    catch (err) { return failure(err); }
  });

  return server;
}

const mcp = createMcpHandler(factory, { responseMode: 'json' });
const nodeHandler = toNodeHandler(mcp);

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function bearer(req) {
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

const httpServer = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'mcp-file-bridge', version: '0.3.0' });

    const uploadMatch = url.pathname.match(/^\/upload\/([0-9a-f-]{36})$/i);
    if (uploadMatch) {
      if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' });
      const lengthHeader = req.headers['content-length'];
      const contentLength = lengthHeader == null ? undefined : Number(lengthHeader);
      if (contentLength != null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) return json(res, 400, { error: 'invalid content-length' });
      try {
        const result = await store.receiveStream({ uploadId: uploadMatch[1], token: bearer(req), stream: req, contentLength });
        return json(res, 201, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = /token|expired|invalid upload/.test(message) ? 401 : 400;
        return json(res, status, { error: message });
      }
    }

    if (url.pathname !== '/mcp') return json(res, 404, { error: 'not found' });
    if (API_TOKEN && bearer(req) !== API_TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="mcp-file-bridge"' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    return nodeHandler(req, res);
  })().catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.destroy(err);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`MCP: ${PUBLIC_BASE_URL}/mcp`);
  console.log(`Direct upload endpoint: ${PUBLIC_BASE_URL}/upload/<id>`);
  if (!API_TOKEN) console.warn('WARNING: MCP_API_TOKEN is not set; /mcp is unauthenticated.');
});

async function shutdown(signal) {
  console.log(`received ${signal}; shutting down`);
  httpServer.close();
  await mcp.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
