---
name: file-transfer
summary: Move ChatGPT/Codex artifacts into the connected file bridge without copying bytes through model context.
---

# File Transfer Bridge

Use the `ingest_file` app tool whenever a file already exists as a ChatGPT attachment or as a host-accessible artifact and the user wants it persisted on the connected bridge.

## Rules

- Never read a binary file into the conversation solely to upload it.
- Never base64-encode the file into MCP arguments.
- Pass the host/local file as the `file` parameter of `ingest_file`; the app descriptor declares `_meta["openai/fileParams"] = ["file"]` so compatible OpenAI hosts can bind the file out of band.
- Set `path` only when the user requests a destination name/path. Otherwise preserve the provided file name.
- Supply `sha256` when an integrity digest is already available or cheap to compute locally.
- If host-native file parameters are unavailable, do not fall back to emitting file bytes through the model. Report the host limitation instead.
- `create_upload` is a fallback for ordinary networked clients. Do not use it from a sandbox that cannot reach the public upload URL.

## Expected flow

1. Artifact exists in the host environment.
2. Call `ingest_file(file=<host file>, path=<optional destination>)`.
3. The OpenAI host converts the file parameter to a temporary provided-file object.
4. The remote app streams the temporary URL directly into persistent storage and returns size + SHA-256.
