# dsh-google-drive

Add Google Drive accounts to the DeepSeek Harness from the sidebar.

The plugin opens a **Google Drive** tab in the left sidebar. From there you can
sign in to Google with OAuth, or paste a service-account key, and then browse
that account's Drive files. The agent gets the same accounts as tools.

<!-- The screenshot lands in docs/ once the panel is running. -->

## What it does

| | |
|---|---|
| **Sidebar tab** | A Google Drive entry in the left rail opens a panel in the central column. |
| **OAuth accounts** | Paste a Google OAuth client id and secret, follow the consent URL, and the account is stored. |
| **Service accounts** | Paste a service-account key JSON. Optionally name a Workspace user to impersonate (domain-wide delegation). |
| **Drive browser** | Browse folders, search by name, inspect a file, and download it — with Google-native documents exported to PDF, DOCX, XLSX and friends. |
| **Agent tools** | The same account list and file operations are exposed to the agent as `google_drive_*` tools. |
| **MCP bridge** | Accounts are mirrored into `~/.google-mcp/accounts.json`, so an installed `google-workspace-mcp` server picks a new account up on its next call — no restart. |

## Install

From the Plugin Manager's **Discover** tab, or directly:

```sh
dsh plugin --profile desktop add "link:/path/to/dsh-google-drive"
```

## Configure

The bundle ships with sensible defaults. To change them, override the
`google-drive` row in your profile's `cordis.patch.yml`:

```yaml
- id: google-drive
  name: 'dsh-google-drive'
  config:
    scopes:
      - 'https://www.googleapis.com/auth/drive'
    defaultAccount: ''
    mcpBridge: true
    storeDir: ''
```

| Key | Default | Meaning |
|---|---|---|
| `scopes` | `['https://www.googleapis.com/auth/drive']` | OAuth scopes requested at sign-in. |
| `defaultAccount` | `''` | Account selected when the panel opens. Empty means the first one. |
| `mcpBridge` | `true` | Mirror the registry into `~/.google-mcp` for `google-workspace-mcp`. |
| `storeDir` | `''` | Registry and credential directory. Empty means `~/.google-mcp`. |

## Where the credentials live

Secrets never touch the bundle patch, the profile file, or a log.

| What | Where |
|---|---|
| Account metadata, OAuth client, refresh token, service key | The DSH credential store (`~/.dsh/.credentials.yaml`), under `google-drive/…` records. |
| Credential files the Drive library reads | `<storeDir>/tokens/<name>.json` and `<storeDir>/keys/<name>.json`, mode `0600`. |
| The registry `google-workspace-mcp` reads | `<storeDir>/accounts.json`. |

Each service account gets **its own copy** of the key file. Removing one
account never deletes a key another account still points at.

## Which sign-in should I use?

**Use a service account** unless you specifically need a user's own Drive.

Google classifies `…/auth/drive` as a *restricted* scope. In production an app
that requests it must pass Google's verification. A service account sidesteps
that entirely: it needs no OAuth consent screen, and access is granted by
sharing a file or folder with the service account's email address.

For a service account:

1. In Google Cloud Console, create a service account and download its key.
2. Share the Drive folder you need with the account's `client_email`.
3. Paste the key JSON into the panel.

**Domain-wide delegation** (the optional "impersonate" field) lets the service
account act as a Workspace user with that user's full Drive access. A Workspace
super-admin must first authorise the service account's client id under
*Admin console → Security → Domain-wide delegation*.

**Use OAuth** when you need the files a specific person can see but has not
shared with anyone. Create an *Desktop app* OAuth client in Google Cloud
Console, and paste its client id and secret into the panel. The panel opens a
loopback consent URL; the sign-in must complete on the same machine.

## Agent tools

| Tool | Arguments |
|---|---|
| `google_drive_list_accounts` | — |
| `google_drive_list_files` | `account`, `folderId?`, `pageSize?` |
| `google_drive_search_files` | `account`, `query`, `pageSize?` |
| `google_drive_download_file` | `account`, `fileId`, `path`, `exportFormat?` |
| `google_drive_upload_file` | `account`, `localPath`, `name?`, `folderId?` |

Adding, replacing and removing an account stays **user-only**. Those actions
grant authority, so the agent cannot perform them.

## Development

```sh
node --check lib/index.js
node --check lib/client.js
```

The bundle has no build step and no runtime dependencies beyond Node's
standard library.

## Licence

MIT — see [LICENSE](LICENSE).
