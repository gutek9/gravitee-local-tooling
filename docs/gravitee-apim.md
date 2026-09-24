# `gravitee-api-management` profile

The main [README](../README.md) covers common setup and daily use.
This guide describes the indexing profile for `gravitee-api-management`.

When the local checkout directory is named `gravitee-api-management`, the CLI
automatically selects the `gravitee-apim` profile for `setup`, `manifest`, and
`index`. If the checkout has another name, pass `--profile gravitee-apim`
explicitly.

The profile prioritizes APIM module instructions and manifests, REST API and
gateway services and tests, definition models, console and portal MCP code, and
quick setup documentation. It permits up to 900 files in the generated manifest;
the generic `default` profile permits up to 500.

## Setup

Prepare `.env` as described in the [generic quick start](../README.md#quick-start),
then run this from the `local-tooling` repository:

```bash
CODE_REPO=/path/to/gravitee-api-management
./bin/local-tooling setup --agents all --repo "$CODE_REPO" --profile gravitee-apim --bootstrap
```

The explicit profile flag also works when the checkout directory has a different
name. Restart your agent if it was already running.

## Upgrade

Follow the [generic upgrade notes](../README.md#upgrade) for `.env`, volume, and
reindexing behavior. Use the APIM profile in the setup command:

```bash
git pull
CODE_REPO=/path/to/gravitee-api-management
./bin/local-tooling stop
./bin/local-tooling setup --agents all --repo "$CODE_REPO" --profile gravitee-apim --bootstrap
```
