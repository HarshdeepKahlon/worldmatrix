# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by Keep a Changelog and this project follows semantic versioning once public versioning starts.

## Unreleased

### Added

- Milestone 1 checklist and long-term open-core + cloud direction in `AGENTS.md`.
- Dashboard benchmark mode for loading multiple WMX assets in one scene.
- Benchmark gizmo controls for positioning/rotating/scaling models.
- Streaming retention controls (`cache` vs `dispose`) and debug logging in benchmark mode.
- Streaming core schema documented at top-level `manifest.streaming`.

### Changed

- Streaming runtime `dispose` behavior now uses out-of-frustum thresholding to avoid refine-toggle thrash.
- Dashboard single-asset preview now exposes streaming retention/dispose controls.

### Fixed

- Streaming dispose-mode refetch loop diagnostics and state-machine stabilization groundwork.
