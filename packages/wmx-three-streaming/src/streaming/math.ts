import * as THREE from 'three';
import type { WMXSphereBounds, WMXTileTransformTRS } from '../schema.js';

export function makeMatrixFromTRS(trs?: WMXTileTransformTRS): THREE.Matrix4 {
  const t = trs?.translation ?? [0, 0, 0];
  const r = trs?.rotation ?? [0, 0, 0, 1];
  const s = trs?.scale ?? [1, 1, 1];
  const pos = new THREE.Vector3(t[0], t[1], t[2]);
  const quat = new THREE.Quaternion(r[0], r[1], r[2], r[3]);
  const scale = new THREE.Vector3(s[0], s[1], s[2]);
  const m = new THREE.Matrix4();
  m.compose(pos, quat, scale);
  return m;
}

export function transformSphere(bounds: WMXSphereBounds, world: THREE.Matrix4): { center: THREE.Vector3; radius: number } {
  const c = new THREE.Vector3(bounds.center[0], bounds.center[1], bounds.center[2]).applyMatrix4(world);

  const sx = new THREE.Vector3().setFromMatrixColumn(world, 0).length();
  const sy = new THREE.Vector3().setFromMatrixColumn(world, 1).length();
  const sz = new THREE.Vector3().setFromMatrixColumn(world, 2).length();
  const maxScale = Math.max(sx, sy, sz, 1e-6);

  return { center: c, radius: bounds.radius * maxScale };
}

export function projectedRadiusPx(params: {
  sphereCenterWorld: THREE.Vector3;
  sphereRadiusWorld: number;
  camera: THREE.PerspectiveCamera;
  viewportHeightPx: number;
}): number {
  const d = params.camera.position.distanceTo(params.sphereCenterWorld);
  if (d <= 1e-6) return Number.POSITIVE_INFINITY;
  const fov = THREE.MathUtils.degToRad(params.camera.fov);
  const denom = d * Math.tan(fov / 2);
  if (denom <= 1e-6) return Number.POSITIVE_INFINITY;
  const radiusNdcY = params.sphereRadiusWorld / denom;
  return radiusNdcY * (params.viewportHeightPx / 2);
}

