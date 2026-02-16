# Contributing

Thanks for contributing to WorldMatrix.

## Development setup

```bash
npm install
```

## Local validation before opening a PR

```bash
npm run build
npm test
```

`npm test` runs the integration suite (`tests/integration/*.test.mjs`).

## Project structure

- `packages/wmx-core`: WMX manifest + streaming schema types/guards.
- `packages/wmx-cli`: asset optimization/build pipeline.
- `packages/wmx-three`: Three.js loader wrapper.
- `packages/wmx-three-streaming`: streaming runtime (selection/loading/eviction).
- `packages/wmx-viewer`: React viewers for static + streaming WMX.
- `packages/wmx-asset-server`: upload/build/serve API.
- `dashboard`: dashboard UI (local + server modes).
- `tests/integration`: end-to-end integration tests.

## Contribution expectations

- Keep WMX manifest contract changes backwards-compatible where possible.
- Prefer integration tests for pipeline/runtime behavior changes.
- Update `AGENTS.md` work log + decisions for significant changes.
- Update docs when changing user-facing behavior, commands, ports, or schema.

## Release notes policy

- Add user-facing changes to `CHANGELOG.md` under `Unreleased`.
- Keep entries brief and grouped by Added/Changed/Fixed.
