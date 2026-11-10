![The Google Drive settings section and the Drive tab in the right sidebar](preview.svg)

# Google Drive accounts

Connect a Google Drive account to the Harness, browse its files beside the
conversation, and drag a file straight into the chat when the agent needs it.

## Connect an account

Press **Add account** in the settings section. The wizard opens with the one
choice most people want — **my own Google account** — and keeps the other two
behind a link, so nobody has to know what an OAuth client is before they can
start:

- **My own Google account** — the plugin signs you in with its own key, so
  there is nothing to set up: one button, Google's sign-in page, done. It
  names the account after the address you signed in with.

  Google will still show *"Google hasn't verified this app"* the first time.
  That is expected, and the wizard says so next to the button: the plugin
  asks for full Drive access, which Google classifies as a restricted scope,
  and an app that has not been verified says so. Choose *Advanced → Go to …*
  to continue.

  You can still bring your own key — for a company policy, or to keep the
  consent screen under your own name — and the wizard walks you through
  creating one in the Cloud console. Only a *Desktop app* key works there,
  because Google refuses a `localhost` callback for a web client.
- **A service account** — for automation, and for files that are shared with
  a service account. It needs no administrator: share the folder with the
  account's own address, and the wizard shows you that address as soon as the
  key is in. It sees **only** what you share with it.
- **My company uses Google Workspace** — the one route that needs an
  administrator: a service account that acts as a user through domain-wide
  delegation. Your administrator allows the app once, and Google can take up
  to a day to apply it. The wizard gives you a block to send them. A personal
  Google account cannot delegate at all, and the wizard says so plainly, so
  nobody spends an afternoon in an admin console that has no such setting.

The wizard tells you what Google will say before you meet it. The first
sign-in on a new key shows Google's *"app is not verified"* screen, and the
answer is *Advanced → Go to …*; the wizard says so next to the button rather
than after the fact.

Either way the sign-in happens on this machine, and the credentials never
leave it.

![The onboarding wizard: one primary choice — my own Google account — a step indicator, and the other two ways to connect behind a disclosure](screenshots/wizard.png)

## Change an account

Every account this plugin owns has an **Edit** button, so an account is not a
one-way door:

- **Rename** it — the credentials move with it.
- **Act as a Workspace user** — set, change or take away the user a service
  account impersonates. Clearing the field is what turns a delegation that
  cannot work into a plain service account that sees the files shared with
  it.
- **Replace the key file** — paste a new key when one is rotated.
- **Sign in again** — renew a Google sign-in whose access expired. The OAuth
  client is already stored, so this is one click and no client id to find.

The **Test** button asks Google whether the credentials really work, and the
section says what came back, in green or in red.

## An account the MCP server owns

An account that the installed `google-workspace-mcp` server added is listed
too, marked **MCP**. Its credentials are the server's — and a key file can
be shared with another account — so this plugin does not rename it or
replace its key. It offers one thing instead: **Make editable**.

That makes this plugin's own copy of the account: a private key file of its
own, the same one every account added here gets. The server keeps the
account and keeps working with it — the shared file still holds it, pointing
at the copy — and the copy here can be renamed, re-keyed and signed in
again like any other account. The account is listed once afterwards, without
the MCP mark.

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

![The Edit account dialog: rename it, change the Workspace user it acts as, replace the key file, and the address to share folders with](screenshots/edit-account.png)

![Settings → Google Drive: the connected accounts, each with an Edit, a Test and a Remove button, and a toggle for the Drive tab in the right sidebar](screenshots/settings.png)

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

**Most people should sign in with their own Google account.** It is the only
route that shows you the files you can already see in drive.google.com, and it
is the only one that needs no administrator at all.

| You want… | Use | What it costs |
|---|---|---|
| Your own Drive files, and files shared with you | **Sign in with Google** | One visit to the Google Cloud console to create a sign-in key. |
| One folder, for automation or for a script | **A service account** | A Google Cloud project, and you must share the folder with the account's address. |
| A company Workspace, as one of its users | **Domain-wide delegation** | Your Workspace super administrator has to allow the app, and Google can take up to a day to apply it. |

**A service account sees nothing until you share something with it.** That is
the trade: it needs no consent screen and no administrator, but it is not "my
Drive" — it is "the one folder I was given". If the files you need belong to a
person who has not shared them, sign in with Google instead.

**If you use "Sign in with Google", Google will say the app is not verified.**
That is expected and it is not a mistake. The plugin asks for
`…/auth/drive`, which Google classifies as a *restricted* scope: an app that
requests it has to pass Google's verification before it can be published to
everybody. Until then Google shows a warning screen, and the answer is
*Advanced → Go to …*. The wizard says so before you press the button, because
you will meet that screen on your first attempt.

## The status of an account means something

The **Test** button asks Google whether the credentials really work, and the
section says what came back. An account that cannot sign in — a service
account whose client id no Workspace administrator authorised, for instance —
says so in as many words, with the reason Google gave, and with the two ways
out that need no administrator: share the folder with the service account, or
connect the Google account itself.

## The credentials stay here

Secrets never reach the bundle patch, the profile file or a log. Each service
account gets its own private copy of its key, and removing one account never
deletes a key another account still points at. An account that belongs to an
installed `google-workspace-mcp` server is listed but read-only here:
removing it unlinks it, and the server keeps its own copy. Taking it into
this plugin makes a copy of its own and leaves the server's file alone.
