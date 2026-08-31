#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import process from 'node:process';

const [filePath, uploadUrl, uploadToken] = process.argv.slice(2);
if (!filePath || !uploadUrl || !uploadToken) {
  console.error('usage: node bin/upload-file.mjs <file> <upload_url> <upload_token>');
  process.exit(2);
}
const info = await stat(filePath);
if (!info.isFile()) throw new Error('path is not a regular file');

const response = await fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${uploadToken}`,
    'content-length': String(info.size),
    'content-type': 'application/octet-stream'
  },
  body: createReadStream(filePath),
  duplex: 'half'
});
const body = await response.text();
if (!response.ok) throw new Error(`upload failed: HTTP ${response.status}: ${body}`);
console.log(body);
