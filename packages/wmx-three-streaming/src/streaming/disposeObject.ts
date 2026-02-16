import * as THREE from 'three';

export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const anyO = o as any;
    const geom = anyO.geometry as THREE.BufferGeometry | undefined;
    if (geom && typeof geom.dispose === 'function') geom.dispose();

    const mat = anyO.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
  });
}

function disposeMaterial(mat: THREE.Material) {
  const anyM = mat as any;
  // Dispose textures referenced on the material.
  for (const k of Object.keys(anyM)) {
    const v = anyM[k];
    if (v && typeof v === 'object' && (v as any).isTexture && typeof (v as any).dispose === 'function') {
      (v as THREE.Texture).dispose();
    }
  }
  if (typeof mat.dispose === 'function') mat.dispose();
}

