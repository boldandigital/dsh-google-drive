# dsh-google-drive

Connect Google Drive to the DeepSeek Harness.

The plugin has no entry in the left sidebar. Connected accounts live in
**Settings → Google Drive**, and the files live in the **Drive** tab of the
right sidebar, next to Workspace files, Browser and Terminal. A file can be
dragged into the conversation, so the agent works with the same Drive the user
does.

## Screenshots

The account names, the addresses and the file names in these screenshots are
invented. The real ones belong to whoever installed the plugin, so they stay
out of the repository.

![Settings → Google Drive: the connected accounts, each with a Test and a Remove button, and a toggle for the Drive tab in the right sidebar](docs/screenshots/settings.png)

![The Drive tab in the right sidebar: the files of an account, each with the kind of file it is](docs/screenshots/drive-tab.png)

## What it does

| | |
|---|---|
| **Settings section** | Settings → Google Drive lists the connected accounts, each with a **Test** button that checks the connection and a **Remove** button behind a confirmation, plus an Add account button, a refresh button and the storage/bridge information. |
| **Guided onboarding** | Add account opens a wizard: sign in with Google through a Desktop app OAuth client, or connect a service account with a key file. |
| **Optional browser** | A toggle in the settings section turns the Drive tab in the right sidebar on or off. The choice is remembered, and the tab is gone the next time the app starts. |
| **Right-sidebar tab** | The Drive tab shows an account picker, a folder breadcrumb with a back button, and the folder's files. Each row carries a badge naming the kind: Google Sheet, Google Doc, Google Slides, Google Drawing, Google Form, Google Script, Folder, Shortcut, or the file's own extension (PDF, XLSX, …) for an ordinary file. |
| **Hand a file to the agent** | Drag a row into the conversation, or press **Add to chat** on it. The file arrives as a reference the agent can act on. |
| **`@` reference menu** | Typing `@` in the composer opens the harness reference menu, which also lists Google Drive files. |
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
| `defaultAccount` | `''` | Account selected when the Drive tab opens. Empty means the first one. |
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
3. Paste the key JSON into the wizard. With the gcloud command line tool
   installed and signed in, the wizard can create the key for you instead.

**Domain-wide delegation** (the optional "impersonate" field) lets the service
account act as a Workspace user with that user's full Drive access. A Workspace
super-admin must first authorise the service account's client id under
*Admin console → Security → Domain-wide delegation*.

**Use OAuth** when you need the files a specific person can see but has not
shared with anyone. The plugin signs in through a loopback consent URL on
`http://localhost`, so it needs a **Desktop app** OAuth client — Google
rejects a localhost callback for a web client. The wizard walks through
creating one in Google Cloud Console and reads the downloaded JSON file in the
browser, so the client id and secret do not have to be typed. The sign-in must
complete on the same machine.

## Handing a file to the agent

Drag a row from the Drive tab into the conversation, or press **Add to chat**
on it. The composer keeps the file as a reference chip.

When the message is sent, the plugin names the account, the file id and the
file in the prompt, so the agent knows which Drive file is meant and which
tool reads it: `google_drive_download_file` for a file,
`google_drive_list_files` for a folder, and `google_drive_search_files` for
other files in the same account. The file names are marked as untrusted user
data.

## Agent tools

| Tool | Arguments |
|---|---|
| `google_drive_list_accounts` | — |
| `google_drive_list_files` | `account`, `folderId?`, `pageSize?` |
| `google_drive_search_files` | `account`, `query`, `pageSize?` |
| `google_drive_download_file` | `account`, `fileId`, `path`, `exportFormat?` |
| `google_drive_upload_file` | `account`, `localPath`, `name?`, `folderId?`, `mimeType?` |

Adding, replacing and removing an account stays **user-only**. Those actions
grant authority, so the agent cannot perform them.

## Development

```sh
node --check lib/index.js
node --check lib/client.js
node --check lib/client.onboarding.js
node --check lib/client.sidebar.js
```

The bundle has no build step and no runtime dependencies beyond Node's
standard library.

## Notes

- A service account sees the items shared with it at the top of its Drive, and
  Drive reports those items with **no parent at all**. The usual
  `'root' in parents` filter therefore matches nothing and the account looks
  empty — the upstream `google-workspace-mcp` server has this blind spot too,
  and its `listFolderContents` reports an empty folder for an account whose
  files are plainly visible. This plugin lists the root of a service account
  with the negated query and keeps the genuinely top-level items.
- `nextPageToken` is not surfaced in the Drive tab, so the file list shows the
  first page only.
- The account picked in the Drive tab is client-side state and resets to the
  first account when the app is reloaded.
- An account that belongs to the `google-workspace-mcp` server is listed in
  the settings section. Its credentials belong to that server, so removing
  it here only unlinks it: the plugin stops offering the account and the
  server keeps its own copy. Remove it in the MCP server's own settings to
  delete the credentials.
- Turning the Drive tab off removes the plugin's view of it. A tab that was
  already open then shows the harness's empty-tab placeholder until it is
  closed; a new session never opens it at all.

## Licence

MIT — see [LICENSE](LICENSE).
