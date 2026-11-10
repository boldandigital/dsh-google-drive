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
| The `hostsalt` account | nobody — it cannot be delegated | **Domain-wide delegation is impossible here, and no admin can change that.** hostsalt.com's mail runs on Zoho (`mx.zoho.com`), so the domain is not a Google Workspace tenant and there is no admin console to authorise client id `118164111347282287563` in. Google says so itself: the token request for `sub=contact@hostsalt.com` returns `unauthorized_client`, while the very same key gets a token when it acts as itself. The account is therefore a plain Google account, and the three real ways out are: share what you need with the `gpl` service account, sign in with OAuth as `contact@hostsalt.com`, or drop it. |
| The npm package owner line (optional) | the npm account holder | The organisation **boldandigital** exists, but npm only lets a *change of owners* happen with real two-factor authentication, and npm no longer accepts a new TOTP method — only a security key. The account has neither, so the handover needs: *Add a 2FA method* → security key (a Mac's Touch ID counts) at <https://www.npmjs.com/settings/larsvonhierblau/tfa>, then the owner change in the browser at the package's **Admin** tab. **It is optional.** The package works, the index lists it, and the author field already says `boldandigital`; only npm's *maintainer* line is still the personal account. |

## Releasing a new version

The version in `package.json` is what npm publishes, and a release is a tag:

```sh
npm version patch     # 0.1.2 -> 0.1.3
git tag v0.1.3 && git push origin main --tags
```

The workflow in `.github/workflows/publish.yml` publishes the tagged version.
Until the trusted publisher below is configured it publishes with the granular
token in `~/.npmrc`; from January 2027 npm stops letting bypass-2FA tokens
publish, so configure the trusted publisher before then:

```sh
npm trust github dsh-google-drive --file publish.yml \
  --repo boldandigital/dsh-google-drive --allow-publish
```

That is the same command the registry refuses without 2FA, because it is an
account change; with a security key registered it goes through.

