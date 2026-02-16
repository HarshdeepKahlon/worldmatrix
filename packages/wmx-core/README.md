# @worldmatrix/wmx-core

Core types and manifest guards for WorldMatrix (`.wmx.json`) assets.

## Install

```bash
npm install @worldmatrix/wmx-core
```

## Usage

```ts
import { isWMXManifestV1 } from '@worldmatrix/wmx-core';

const parsed = JSON.parse(manifestJson);
if (!isWMXManifestV1(parsed)) {
  throw new Error('Invalid WMX manifest');
}
```
