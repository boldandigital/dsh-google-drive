# Internal contract — `dsh-google-drive`

Both halves of this plugin are written against this document. It is the only
agreement between `lib/index.js` (host) and `lib/client.js` (browser).

## Identity

| Item | Value |
|---|---|
| Package name | `dsh-google-drive` |
| Host half | `lib/index.js` |
| Client half | `lib/client.js` |
| Client factory id | `dsh-google-drive` (MUST equal the package name) |
| RPC channel | `/api` |
| RPC namespace | `google-drive` |
| Panel id (`sidebar.panellist` id AND `main` key) | `google-drive` |
| Locale namespace | `google-drive` |

## Transport

Client → Host:

```js
const result = await ctx.connection.rpc.call('/api', 'google-drive/<endpoint>', payload);
// result === { ok: true, value } | { ok: false, error: { code, message, details } }
```

Host → Client: exact Fetch routes on `ctx.connection.fetch.register`:

```js
ctx.connection.fetch.register({
  path: `/api/google-drive/<endpoint>`,
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: async (request) => Response,   // JSON envelope
});
```

Request body: `{ type: 'client-request', rpcId: string, method: string, payload: JsonValue }`
Response body: `{ type: 'server-response', rpcId: string, result: { ok: true, value } | { ok: false, error: { code, message, details } } }`

`ctx.connection.fetch.register` is mandatory — `connection.rpc.handle` breaks for
third-party channels (its disposer resolves `owner.webServer` against the
Connection plugin's own fiber, so the channel throws inside a child fiber and
vanishes without a boot error).

Client `inject`: `['slots', 'connection', 'locale']`
Host `inject`: `['connection', 'credentials', 'tools']`

## Endpoints

Every payload is a plain JSON object. Every value is plain JSON.

### `accounts/list`

Payload `{}`.

```jsonc
{
  "accounts": [
    {
      "name": "hostsalt",              // unique key, ^[a-zA-Z0-9_-]+$
      "email": "contact@hostsalt.com", // may be null before the first probe
      "type": "oauth",                 // "oauth" | "service_account"
      "subject": null,                 // service account only: impersonated Workspace user
      "addedAt": "2026-11-08T13:28:50.643Z",
      "scopes": ["https://www.googleapis.com/auth/drive"],
      "status": "ready",               // "ready" | "error" | "unknown"
      "foreign": false                 // true when the upstream MCP server owns it
    }
  ],
  "mcpBridge": {
    "enabled": true,                   // the plugin mirrors accounts into ~/.google-mcp
    "path": "/Users/lars/.google-mcp", // absolute path, or null when disabled
    "installed": true                  // a google-workspace-mcp server was detected
  },
  "storage": "credentials"             // "credentials" | "files"
}
```

A `foreign` account belongs to the `google-workspace-mcp` server rather than to
this plugin. It is listed and can be browsed with, but it cannot be removed
here: its key file may be shared with another account, and the server that owns
it may still be using it.

### `onboarding/detect`

Payload `{}`.

Reports what this machine can already supply, so the panel can offer a
one-click path instead of asking the user to type what is already installed.

```jsonc
{
  "gcloud": {
    "available": true,                       // a gcloud binary was found
    "path": "/Users/lars/google-cloud-sdk/bin/gcloud",
    "version": "592.0.0",                   // the SDK version, or null
    "authenticated": true,                   // it has an active credential
    "account": "lars.z@icloud.com",         // the active account, or null
    "projects": [                            // the projects it can reach
      { "id": "charged-garden-280823", "name": "Google Sheet Integration" }
    ]
  },
  "oauthClients": [                          // OAuth clients found on disk
    {
      "path": "/Users/lars/Downloads/client_secret_123.apps.googleusercontent.com.json",
      "clientId": "123.apps.googleusercontent.com",
      "projectName": "Untitled project",     // may be null
      "type": "web"                          // "web" | "installed"
    }
  ],
  "serviceAccounts": [                      // service accounts gcloud can create a key for
    {
      "email": "gpl-love-mcp@charged-garden-280823.iam.gserviceaccount.com",
      "projectId": "charged-garden-280823",
      "displayName": "GPL Love MCP"
    }
  ]
}
```

Every field degrades on its own: a missing `gcloud` yields
`"available": false`, and an unreadable directory yields an empty list. The
endpoint never fails because a probe failed — a probe that throws is reported
as "not available", never as an error.

The client secret of a discovered OAuth client is never reported here — only
what a chooser needs. The secret stays on disk.

`type` matters: this plugin signs in through a loopback callback
(`http://localhost:<port>`), and Google accepts that only for an `installed`
(Desktop app) client. A `web` client cannot be used here.

### `onboarding/create-service-key`

Payload `{ projectId, serviceAccountEmail }`.

Creates a new JSON key for an existing service account and returns the key
fields. The account must already exist; this endpoint mints a key for it.

```jsonc
{
  "key": {
    "type": "service_account",
    "project_id": "charged-garden-280823",
    "private_key_id": "…",
    "private_key": "-----BEGIN PRIVATE KEY-----\n…",
    "client_email": "gpl-love-mcp@charged-garden-280823.iam.gserviceaccount.com",
    "client_id": "…"
  }
}
```

The key is written by the caller through `accounts/add-service`; it never
travels to the browser twice.

### `oauth/start`

Payload `{ name, clientId, clientSecret, scopes? }`.

`scopes` defaults to `["https://www.googleapis.com/auth/drive"]`.

Returns `{ flowId, authUrl, expiresAt }`. The host opens no browser; the user
follows `authUrl`.

### `oauth/status`

Payload `{ flowId }`.

Returns `{ status: 'pending' | 'authorized' | 'failed', message?, account? }`
where `account` is the account record on success.

### `oauth/cancel`

Payload `{ flowId }` → `{}`.

### `accounts/add-service`

Payload `{ name, keyJson, subject? }`.

`keyJson` is the pasted service-account key as a JSON **string** (the private
key keeps its newlines when encoded this way). `subject` is the Workspace user
to impersonate, for domain-wide delegation.

Returns `{ account }`. Failure: `error.code === 'invalid-key'`.

### `accounts/remove`

Payload `{ name }` → `{ removed: true }`.

The host never deletes a key file another account still points at.

### `drive/list`

Payload `{ account, folderId?, pageSize?, query? }`.

`folderId` defaults to `"root"`. `query` is an optional Drive query string.

Returns `{ files: DriveFile[], nextPageToken? }`.

### `drive/search`

Payload `{ account, query, pageSize? }` → `{ files: DriveFile[], nextPageToken? }`.

### `drive/download`

Payload `{ account, fileId, path, exportFormat? }`.

`exportFormat` is required for Google-native documents and one of
`pdf | docx | txt | xlsx | csv | pptx | html | png | jpeg`.

Returns `{ path, bytes }`.

### `drive/upload`

Payload `{ account, localPath, name?, folderId?, mimeType? }` → `{ file: DriveFile }`.

### `drive/get-file`

Payload `{ account, fileId }` → `{ file: DriveFile }`.

## DriveFile

```jsonc
{
  "id": "1AbC…",
  "name": "Budget Q4.xlsx",
  "mimeType": "application/vnd.google-apps.spreadsheet",
  "size": 0,                     // 0 for native Google files
  "modifiedTime": "2026-11-07T09:12:00.000Z",
  "parents": ["root"],
  "webViewLink": "https://drive.google.com/…",
  "iconLink": "https://drive-thirdparty.googleusercontent.com/…"
}
```

## Error codes

`invalid-key`, `unknown-account`, `unknown-endpoint`, `oauth-failed`,
`drive-api`, `io`, `internal`. `details` is always an object.

`invalid-key` covers every rejected request field as well as a malformed
service-account key; the offending field is named in `details.field`.

## Storage

Secrets live in the DSH credential store (`ctx.credentials`), one record per
concern. The store addresses records as `<scope>/<id>` with each segment
matching `^[a-z][a-z0-9-]*$`, so a three-segment key would make the whole
credentials document unparseable. The keys are therefore:

| Key | Payload |
|---|---|
| `google-drive/account-<enc>` | account metadata (no secret) |
| `google-drive/oauth-client-<enc>` | `{ clientId, clientSecret }` |
| `google-drive/refresh-token-<enc>` | `{ refreshToken }` |
| `google-drive/service-key-<enc>` | the service-account key fields |

`<enc>` is a reversible lowercase encoding of the account name. The client
half never sees these keys.

When the profile has no credential service, the plugin falls back to its own
files and says so through `storage`.

The plugin's private files live under `<storeDir>/dsh-google-drive/`. They must
not share a directory with the upstream MCP server, which keeps its own tokens
in `<storeDir>/tokens` and its client secrets in `<storeDir>/credentials`:
sharing those would let this plugin's cleanup destroy a token the server still
needs.

| What | Where |
|---|---|
| Account metadata | `credentials` record, mirrored to `<storeDir>/dsh-google-drive/meta/<name>.json` |
| OAuth refresh token and client | `credentials` records, mirrored to `<storeDir>/dsh-google-drive/tokens/<name>.json` |
| Service-account key | `credentials` record, mirrored to `<storeDir>/dsh-google-drive/keys/<name>.json` (mode 0600) |

Account metadata is also mirrored to `<storeDir>/accounts.json` in the format
`google-workspace-mcp` reads, so an installed MCP server picks the account up on
its next call without a restart. The mirror is best effort: a failure is a
warning, never an error. It preserves entries this plugin did not write, and it
never deletes a file another account still points at.

## Scope

Drive access uses `https://www.googleapis.com/auth/drive` by default. The
service-account path needs no OAuth consent screen, which is the only way to
use a restricted Drive scope without Google app verification.

The host registers five tools that call the same service methods the UI calls.

| Tool | Arguments | Returns |
|---|---|---|
| `google_drive_list_accounts` | — | the account list |
| `google_drive_list_files` | `account`, `folderId?`, `pageSize?` | files |
| `google_drive_search_files` | `account`, `query`, `pageSize?` | files |
| `google_drive_download_file` | `account`, `fileId`, `path`, `exportFormat?` | path, bytes |
| `google_drive_upload_file` | `account`, `localPath`, `name?`, `folderId?` | the file |

Adding, replacing and removing an account stays **user-only**: it grants
authority, so no agent tool may perform it.

