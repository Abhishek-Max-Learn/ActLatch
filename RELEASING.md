# Releasing a new version

1. Add what changed under a new version heading in `CHANGELOG.md`.
2. Change `"version"` in `package.json` to the same number (and run `npm install` so `package-lock.json` matches).
3. Merge that to `main`.
4. On GitHub: **Releases → Draft a new release**, tag `v` + the version (for example `v0.1.0`), paste the changelog
   section as the notes, and click **Publish release**.

The `publish` workflow then runs the tests, builds, and publishes to npm with provenance (the signed
"built from this repo" record). If the tag and `package.json` disagree, it stops without publishing.

## One-time npm setup

1. Create an account on npmjs.com and turn on two-factor authentication.
2. First publish only: create a granular access token on npmjs.com (publish rights) and save it in GitHub under
   **Settings → Secrets and variables → Actions** as `NPM_TOKEN`.
3. After the first publish: on npmjs.com open the package's **Settings → Trusted publishing**, add GitHub Actions
   with this repository and workflow `publish.yml`, then delete the `NPM_TOKEN` secret and the token. From then on
   no long-lived password exists that could leak.
