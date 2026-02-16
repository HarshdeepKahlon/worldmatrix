import { REVISION } from 'three';

export type WMXDecoderPaths = {
  basisTranscoderPath: string;
  dracoDecoderPath: string;
  threeVersion: string;
};

export type WMXDecoderPathsOptions = Partial<{
  cdnBaseUrl: string;
  threeVersion: string;
  basisTranscoderPath: string;
  dracoDecoderPath: string;
}>;

const DEFAULT_CDN_BASE = 'https://unpkg.com';

export function defaultDecoderPathsFromThree(options: WMXDecoderPathsOptions = {}): WMXDecoderPaths {
  const threeVersion = options.threeVersion ?? revisionToNpmVersion(REVISION);
  const cdnBaseUrl = trimTrailingSlash(options.cdnBaseUrl ?? DEFAULT_CDN_BASE);

  return {
    threeVersion,
    basisTranscoderPath: ensureTrailingSlash(
      options.basisTranscoderPath ?? `${cdnBaseUrl}/three@${threeVersion}/examples/jsm/libs/basis/`
    ),
    dracoDecoderPath: ensureTrailingSlash(
      options.dracoDecoderPath ?? `${cdnBaseUrl}/three@${threeVersion}/examples/jsm/libs/draco/`
    )
  };
}

function revisionToNpmVersion(revision: string): string {
  const n = Number.parseInt(revision, 10);
  if (Number.isFinite(n) && n > 0) return `0.${n}.0`;
  return `0.${revision}.0`;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
