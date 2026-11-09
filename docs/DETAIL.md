![The Google Drive settings section and the Drive tab in the right sidebar](preview.svg)

# Google Drive accounts

Connect a Google Drive account to the Harness, browse its files beside the
conversation, and drag a file straight into the chat when the agent needs it.

## Connect an account

Press **Add account** in the settings section. The two ways in are tabs, and
each one ends in a single button:

- **Google account** — the plugin looks for an OAuth client this Mac already
  has, picks it, and opens Google's sign-in. Only a *Desktop app* client
  works, because Google refuses a `localhost` callback for a web client; the
  wizard says so and walks through creating one if the machine has none.
- **Service account** — paste the key file, or let the wizard create one with
  the `gcloud` command line tool.

Either way the sign-in happens on this machine, and the credentials never
leave it.

## Browse the files

The connected account's files live in the **Drive** tab of the right sidebar,
next to Workspace files, Browser and Terminal. Each row carries a badge
naming the kind of file it is — Google Sheet, Google Doc, Google Slides,
Google Drawing, Google Form, Google Script, Folder, Shortcut — or the file's
own extension for an ordinary file.

## Hand a file to the agent

Drag a row into the conversation, or press **Add to chat** on it. The file
arrives as a reference chip, and the agent knows which account it came from
and which tool reads it: `google_drive_download_file` for a file,
`google_drive_list_files` for a folder, `google_drive_search_files` for the
rest of that account.

Typing `@` in the composer opens the reference menu, which lists Drive files
next to everything else.

![Settings → Google Drive: the connected accounts, each with a Test and a Remove button, and a toggle for the Drive tab in the right sidebar](screenshots/settings.png)

![The Drive tab in the right sidebar: the files of an account, each with the kind of file it is](screenshots/drive-tab.png)

## What the agent can do

| | |
|---|---|
| `google_drive_list_accounts` | The accounts this machine can use. |
| `google_drive_list_files` | The files of a folder. |
| `google_drive_search_files` | The files of an account that match a name. |
| `google_drive_download_file` | A file into the workspace, exported when it is a Google document. |
| `google_drive_upload_file` | A file from the workspace to Drive. |

Adding, replacing and removing an account stays with the user. Those actions
grant authority, so no agent can perform them.

## Which sign-in should I use?

**A service account, unless the files you need belong to a person who has not
shared them.** Google classifies `…/auth/drive` as a restricted scope, and an
app that requests it in production has to pass Google's verification. A
service account sidesteps that: no consent screen, and access is granted by
sharing a folder with the account's email address.

**OAuth** is the one to choose when you need the files a specific person can
see but has not shared with anyone.

## The status of an account means something

The **Test** button asks Google whether the credentials really work, and the
section says what came back. An account that cannot sign in — a service
account whose client id no Workspace administrator authorised, for instance —
says so in as many words, with the reason Google gave, instead of showing a
green light that means nothing.

## The credentials stay here

Secrets never reach the bundle patch, the profile file or a log. Each service
account gets its own private copy of its key, and removing one account never
deletes a key another account still points at. An account that belongs to an
installed `google-workspace-mcp` server is listed but read-only here:
removing it unlinks it, and the server keeps its own copy.
