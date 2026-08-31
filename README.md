# mcp-file-bridge

A remote MCP control plane plus a **direct streaming HTTP data plane** for moving large sandbox artifacts without placing their bytes in the model context or MCP tool arguments.

## The important bit

Do **not** send a 1 GB file as base64 in `tools/call.arguments`.

The intended flow is:

```text
model / MCP control plane                         code / data plane

create_upload(path, size, sha256)
        |
        +--> upload_url + short-lived token
                         |
                         +--> fs.createReadStream("/mnt/data/file.iso")
                              PUT /upload/<id>
                              (raw bytes stream directly to server)
```

The model only sees small metadata: path, size, digest, upload ID, URL and token. The actual bytes are moved by the execution/runtime layer, so a multi-gigabyte file does **not** consume multi-gigabytes of LLM context.

Standard MCP tool inputs are JSON-schema arguments. MCP itself does not give a remote server a magic file descriptor for the caller's `/mnt/data`. This project therefore separates the control plane (MCP) from the data plane (HTTP streaming).

## MCP tools

- `create_upload(path, size_bytes, sha256?, ttl_seconds?)` — return a short-lived `upload_url` and `upload_token`.
- `get_upload(upload_id)` — inspect session state.
- `cancel_upload(upload_id)` — cancel a pending session.
- `list_files(prefix?)`
- `stat_file(path)`
- `delete_file(path)`

There is intentionally **no** `upload_chunk(data_base64)` tool.

## Streaming a sandbox file

After `create_upload` returns an URL/token, code can stream the file without reading it into model context or process memory.

With curl:

```bash
curl --fail --show-error \
  -X PUT \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  --upload-file /mnt/data/huge-file.img \
  "$UPLOAD_URL"
```

Or with the included Node client:

```bash
node bin/upload-file.mjs /mnt/data/huge-file.img "$UPLOAD_URL" "$UPLOAD_TOKEN"
```

`createReadStream()` provides backpressure and does not buffer the whole file in RAM.

### Important client-side limitation

The environment executing the upload code must be allowed to make an outbound HTTPS request to your bridge. If a particular sandbox blocks arbitrary outbound networking, standard MCP cannot bypass that restriction by stuffing the bytes into tool arguments. A platform-native connector file transport would be another option if the client runtime exposes one.

## Server-side behavior

`PUT /upload/<id>`:

- authenticates a random, short-lived one-upload token;
- streams request bytes directly into a temporary file;
- enforces the declared byte length and `MAX_FILE_BYTES`;
- computes SHA-256 incrementally while streaming;
- optionally verifies the SHA-256 supplied to `create_upload`;
- atomically moves the finished file into `/data/files`;
- never parses the body as JSON/base64.

Default maximum file size is **10 GiB**.

## Deploy

```bash
cp .env.example .env
# Set PUBLIC_BASE_URL and a strong MCP_API_TOKEN.
docker compose up -d --build
```

Health check:

```bash
curl https://your-host.example/healthz
```

MCP endpoint:

```text
https://your-host.example/mcp
```

For production, put TLS/reverse proxy in front of the container. Make sure your proxy does not impose a smaller request-body limit and does not buffer large request bodies to memory.

### Nginx example settings

```nginx
client_max_body_size 10g;
proxy_request_buffering off;
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

## Environment variables

| Variable | Default | Purpose |
| --- | ---: | --- |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `3000` | Listen port |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:3000` | Public HTTPS origin returned by `create_upload` |
| `DATA_DIR` | `/data` | Persistent storage root |
| `MCP_API_TOKEN` | empty | Bearer token for `/mcp` |
| `MAX_FILE_BYTES` | `10737418240` | Maximum complete file size (10 GiB) |

## Security

- Upload tokens are random 256-bit values, stored only as SHA-256 hashes server-side, and expire by default after 15 minutes.
- Completed upload manifests no longer retain the token hash.
- Destination paths reject `..` traversal and remain inside `/data/files`.
- Existing destination files are not overwritten implicitly.
- Avoid putting upload tokens in query strings; this implementation uses the `Authorization` header so reverse-proxy access logs do not normally record them.

## Test

```bash
npm install
npm test
```

## License

MIT
