# Where this plugin is published

Three channels, all reachable today. This file records what each one needs,
so nothing has to be rediscovered later.

## 1. npm — the install path

The package is published as [`dsh-google-drive`](https://www.npmjs.com/package/dsh-google-drive).

```sh
dsh plugin --profile web add dsh-google-drive
```

npm is the channel the harness itself resolves: `dsh plugin add <name>` looks
a package name up in the registry, and the plugin market index format's
`source: { "type": "npm" }` points at a registry version with its publish time
and its `engines.dsh`. A Git-only plugin cannot be installed with one command
on another machine.

Publishing it costs nothing, and the package stays on the registry.

| | |
|---|---|
| Package name | `dsh-google-drive` |
| Registry owner | the npm account that published it |
| Author field | `boldandigital (https://github.com/boldandigital)` |
| Versions | `0.1.0`, `0.1.1` |

The npm **name** is permanent: npm only allows an unpublish within 72 hours
of a release, and the name stays reserved afterwards. Publishing `0.1.2` and
later is the only way forward.

## 2. The plugin market index — the Discover tab

The index is its own repository, published with GitHub Pages:

```text
https://boldandigital.github.io/dsh-plugin-index/index.json
```

Add it under **Plugins → Discover → Manage index sources**, then the plugin
appears in the Discover tab with its icon, its description and its detail
document, and one click installs it.

The index follows the market format version 1 and is validated with
`@deepseek-ai/dsh-plugin-market-index`, the same validator the harness uses.
A daily workflow rebuilds it from the npm registry, so it never names a version
the registry does not have.

## 3. dsh-plugin.org — the community hub

A third-party hub, not affiliated with DeepSeek. It has no submission form and
no public listing repository: **the crawler finds plugins by GitHub topic**.

- The repository carries the `dsh-plugin` topic.
- The root `package.json` names the package and points `repository` at this
  owner/repo, which is what binds the npm package to the listing.
- The README carries the install command.
- The submission issue asks a human for the category and flips the entry from
  *unconfirmed* to *verified*.

The entry appears on the site once the crawler has run. The badge
`[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/boldandigital/dsh-google-drive)`
is added to this README at that point — the badge file itself is served for
every URL, so adding it earlier would claim a listing that does not exist.

## 4. The first-party route

`github.com/deepseek-ai/deepseek-harness` holds the **format** and a
**reference generator** for plugin market indexes — it does not carry a
curated list of third-party plugins, and the shipped harness configures **no
index source at all**. A pull request there would therefore mean vendoring the
plugin into the first-party monorepo (TypeScript, their build, their
conventions), which is a different thing from listing a third-party plugin.

## Two things that need a person

| What | Who | How |
|---|---|---|
| The npm package owner line | the npm account holder | Create the npm organisation **boldandigital** at <https://www.npmjs.com/org/create>, then transfer `dsh-google-drive` to it. The registry refuses to create an organisation through its API, so this one click is unavoidable. |
| The `hostsalt` account | a hostsalt.com super-admin | Authorise client id `118164111347282287563` for `https://www.googleapis.com/auth/drive` under **Admin console → Security → API access → Domain-wide delegation**. Until then the account refuses its token, and the plugin says exactly what is missing. |
