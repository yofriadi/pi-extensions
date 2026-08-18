# Release protection configuration

The release workflow separates provenance validation (no OIDC permission) from the `npm-publish` environment, which alone receives `id-token: write`.

Repository settings must keep these controls active:

1. A repository ruleset protects `refs/tags/v*` from creation, update, and deletion except for repository administrators who operate the reviewed release helper. This prevents ordinary contributors from creating a release-triggering tag.
2. The `npm-publish` environment requires a deployment review and permits deployments only from `v*` release tags. The environment is the final human approval boundary before OIDC publication.

The workflow still verifies that a release tag is plain `vX.Y.Z`, matches `package.json`, and is reachable from `local/main`; rules or environment approval do not replace those checks.
