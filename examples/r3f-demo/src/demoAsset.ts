import type { WMXManifestV1 } from '@worldmatrix/wmx-core';

const TINY_TRIANGLE_GLB_BASE64 =
  'Z2xURgIAAADQAgAAiAIAAEpTT057ImFzc2V0Ijp7ImdlbmVyYXRvciI6ImdsVEYtVHJhbnNmb3JtIHY0LjMuMCIsInZlcnNpb24iOiIyLjAifSwiYWNjZXNzb3JzIjpbeyJuYW1lIjoiUE9TSVRJT04iLCJ0eXBlIjoiVkVDMyIsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozLCJtYXgiOlsxLDEsMF0sIm1pbiI6WzAsMCwwXSwiYnVmZmVyVmlldyI6MCwiYnl0ZU9mZnNldCI6MH0seyJuYW1lIjoiaW5kaWNlcyIsInR5cGUiOiJTQ0FMQVIiLCJjb21wb25lbnRUeXBlIjo1MTIzLCJjb3VudCI6MywiYnVmZmVyVmlldyI6MSwiYnl0ZU9mZnNldCI6MH1dLCJidWZmZXJWaWV3cyI6W3siYnVmZmVyIjowLCJieXRlT2Zmc2V0IjowLCJieXRlTGVuZ3RoIjozNiwiYnl0ZVN0cmlkZSI6MTIsInRhcmdldCI6MzQ5NjJ9LHsiYnVmZmVyIjowLCJieXRlT2Zmc2V0IjozNiwiYnl0ZUxlbmd0aCI6OCwidGFyZ2V0IjozNDk2M31dLCJidWZmZXJzIjpbeyJieXRlTGVuZ3RoIjo0NH1dLCJtZXNoZXMiOlt7Im5hbWUiOiJUcmlhbmdsZSIsInByaW1pdGl2ZXMiOlt7ImF0dHJpYnV0ZXMiOnsiUE9TSVRJT04iOjB9LCJtb2RlIjo0LCJpbmRpY2VzIjoxfV19XSwibm9kZXMiOlt7Im5hbWUiOiJSb290IiwibWVzaCI6MH1dLCJzY2VuZXMiOlt7Im5hbWUiOiJTY2VuZSIsIm5vZGVzIjpbMF19XX0sAAAAQklOAAAAAAAAAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAQACAAAA';

export function makeTinyGlbDataUrl(): string {
  return `data:model/gltf-binary;base64,${TINY_TRIANGLE_GLB_BASE64}`;
}

export function makeDemoManifestDataUrl(): string {
  const glbUrl = makeTinyGlbDataUrl();

  const manifest: WMXManifestV1 = {
    schemaVersion: '1.0',
    assetId: 'demo-tiny-triangle',
    name: 'Demo Triangle (embedded)',
    variants: {
      low: { url: glbUrl },
      medium: { url: glbUrl },
      high: { url: glbUrl }
    },
    artifacts: {
      stats: 'data:application/json,{}'
    }
  };

  const json = encodeURIComponent(JSON.stringify(manifest));
  return `data:application/json;charset=utf-8,${json}`;
}

