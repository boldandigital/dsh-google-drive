## Description

Adds a **Google Drive** tab to the DeepSeek Harness sidebar.

From that tab you can:

- sign in to Google with OAuth (paste a Desktop-app OAuth client id and secret, follow the consent link),
- or add a service account by pasting its key JSON, optionally impersonating a Workspace user for domain-wide delegation,
- browse folders, search by file name, inspect a file and download it — with Google-native documents exported to PDF, DOCX, XLSX and friends,
- remove an account you added here.

The agent gets the same accounts as tools: `google_drive_list_accounts`,
`google_drive_list_files`, `google_drive_search_files`,
`google_drive_download_file` and `google_drive_upload_file`.

Adding, replacing and removing an account stays **user-only** — those actions
grant authority, so no model-facing tool can perform them.

## Which sign-in should I use?

Google classifies `…/auth/drive` as a *restricted* scope, so an app that
requests it must pass Google's verification in production. A **service
account** sidesteps that entirely: it needs no OAuth consent screen, and access
is granted by sharing a file or folder with the service account's email.

For a service account:

1. Create one in Google Cloud Console and download its key.
2. Share the Drive folder you need with the account's `client_email`.
3. Paste the key JSON into the panel.

**Domain-wide delegation** (the optional "impersonate" field) lets the service
account act as a Workspace user. A Workspace super-admin must first authorise
the service account's client id under *Admin console → Security → Domain-wide
delegation*.

Use **OAuth** when you need the files a specific person can see but has not
shared with anyone. Create a *Desktop app* OAuth client in Google Cloud
Console and paste its client id and secret into the panel. The sign-in must
complete on the same machine.

## Where the credentials live

Secrets never touch the bundle patch, the profile file, or a log.

- The DSH credential store (`~/.dsh/.credentials.yaml`), under `google-drive/…` records.
- The plugin's own private files under `<storeDir>/dsh-google-drive/`, mode `0600`.

Each service account gets **its own copy** of the key file, and the plugin
never writes into the directories the `google-workspace-mcp` server owns. An
account that server manages is shown as read-only here.

## Compatibility with google-workspace-mcp

When the `mcpBridge` option is on (the default), the plugin mirrors its
accounts into `<storeDir>/accounts.json` in the format
`google-workspace-mcp` reads, so an installed server picks a new account up on
its next call — no restart. The mirror preserves entries the plugin did not
write.

## Notes

- The plugin adds no npm dependency: it talks to Google over plain REST.
- `nextPageToken` is not surfaced in the panel, so the file list shows the
  first page only.
- The active account is client-side state and resets to the first account when
  the page is reloaded.
