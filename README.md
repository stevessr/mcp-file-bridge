# mcp-file-bridge

A deliberately small remote MCP server for moving binary artifacts from an agent/tool sandbox into persistent storage **without printing the file contents into chat**.

It uses a portable MCP flow:

1. `begin_upload(path, size_bytes, sha256?)`
2. `upload_chunk(upload_id, offset, data_base64)` repeatedly
3. `finish_upload(upload_id, sha256?)`

The server verifies byte counts, optionally verifies SHA-256, rejects path traversal, writes to a temporary file, and atomically moves the completed artifact into `/data/files`.

## Why chunks instead of a native `file` argument?

MCP tool inputs are JSON-schema values. A generic remote MCP server cannot open a ChatGPT sandbox path such as `/mnt/data/foo.zip`; that path exists only inside the caller's sandbox. Chunking is the interoperable fallback: the agent reads the local file privately and sends binary chunks in MCP tool calls. The bytes are not emitted as assistant-visible chat text.

If a future/custom connector runtime provides a platform-native file-reference transport, it can be added as an additional adapter without changing the storage layer.

## Tools

- `begin_upload` — create an upload session.
- `upload_chunk` — append one sequential base64 chunk.
- `finish_upload` — validate and atomically publish the file.
- `cancel_upload` — discard an incomplete upload.
- `list_files` — list stored files.
- `stat_file` — get size, timestamp, and SHA-256.
- `delete_file` — delete one stored file.

Default limits:

- max file: 512 MiB
- max decoded chunk: 512 KiB

Both are configurable with environment variables.

## Deploy with Docker Compose

```bash
cp .env.example .env
# edit .env and set a long random MCP_API_TOKEN
docker compose up -d --build
```

Health check:

```bash
curl http://127.0.0.1:3000/healthz
```

Remote MCP endpoint:

```text
https://YOUR-DOMAIN.example/mcp
```

Put TLS/reverse proxy in front of the container. Do **not** expose an unauthenticated write-capable endpoint to the public Internet.

## Authentication

If `MCP_API_TOKEN` is set, `/mcp` requires:

```http
Authorization: Bearer <token>
```

If your ChatGPT/custom-app configuration cannot send a static bearer token, terminate authentication at your reverse proxy or add the OAuth flow required by your deployment environment. `/healthz` is intentionally public and contains no file data.

## Environment variables

| Variable | Default | Purpose |
| --- | ---: | --- |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `/data` | Persistent storage root |
| `MCP_API_TOKEN` | empty | Optional bearer token |
| `MAX_FILE_BYTES` | `536870912` | Maximum complete file size |
| `MAX_CHUNK_BYTES` | `524288` | Maximum decoded chunk size |

## Storage layout

```text
/data/
  .uploads/       # temporary chunks + manifests
  files/          # completed files
```

Uploaded paths are always relative to `/data/files`; absolute paths and `..` traversal are rejected.

## Local test

Storage tests do not require an MCP client:

```bash
npm test
```

Run the server:

```bash
npm install
MCP_API_TOKEN=test-secret npm start
```

The implementation targets Node.js 22 and the stable v2 `@modelcontextprotocol/server` / `@modelcontextprotocol/node` packages.

## Operational notes

- This initial version assumes one shared persistent filesystem. For multiple replicas, replace the storage layer with S3/R2/object storage or enforce sticky/single-replica deployment.
- `finish_upload` refuses to overwrite an existing destination. Delete or choose a new path explicitly.
- Base64 costs roughly 33% more bytes on the wire. Use larger chunks only after confirming your MCP host's tool-call size limits.
- The bridge intentionally does not implement `upload_from_url`; avoiding arbitrary server-side fetches reduces SSRF risk.

## License

MIT
