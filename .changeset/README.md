# Changesets

Every pull request that changes what users get from `hookgres` adds a
changeset: run `pnpm changeset`, pick patch, minor or major, and write one
line for the changelog. Docs, site and CI changes don't need one.

On `main`, CI keeps a "Version Packages" pull request open that bumps the
version and updates CHANGELOG.md. Merging it publishes to npm. See
CONTRIBUTING.md.
