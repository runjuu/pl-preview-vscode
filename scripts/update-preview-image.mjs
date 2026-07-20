#!/usr/bin/env node
// Update the pinned preview-server image in src/containerSpec.ts to the latest
// build published to GHCR by runjuu/PrairieLearn's `publish-quesal-image`
// workflow (which tags every build `latest`, `sha-<short>`, and `sha-<long>`).
//
// The pin has the form `ghcr.io/runjuu/prairielearn:sha-<short>@sha256:<digest>`:
// a human-readable commit tag plus the immutable manifest-list digest that is
// what Docker actually pulls. This script resolves BOTH halves from the SAME
// `latest` image so they can never drift:
//   - digest: the manifest-list digest `latest` currently resolves to.
//   - sha-<short>: derived from that image's own `org.opencontainers.image.revision`
//     label (the commit it was built from), not from the branch HEAD — a build
//     can lag the branch, and the label is the ground truth for a given image.
// It then cross-checks that the `sha-<short>` tag resolves to the same digest
// before rewriting the pin. Zero dependencies: Node >= 24 global fetch only.
//
// Usage:
//   node scripts/update-preview-image.mjs            # update the pin in place
//   node scripts/update-preview-image.mjs --dry-run  # print the new ref, write nothing
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'ghcr.io';
const IMAGE = 'runjuu/prairielearn';
const TAG = 'latest';
const REVISION_LABEL = 'org.opencontainers.image.revision';
const SPEC_PATH = fileURLToPath(new URL('../src/containerSpec.ts', import.meta.url));
// Captures the quoted image ref on the `DEFAULT_PREVIEW_IMAGE` line.
const PIN_RE = /(export const DEFAULT_PREVIEW_IMAGE\s*=\s*')([^']*)(';)/;

// Media types we accept when asking for a manifest: OCI + legacy Docker, both
// index (multi-arch) and single-image, so ghcr returns the manifest as-is
// rather than transcoding.
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

const dryRun = process.argv.includes('--dry-run');

/** Anonymous pull token for the public GHCR repository. */
async function getToken() {
  const url = `https://${REGISTRY}/token?scope=repository:${IMAGE}:pull&service=${REGISTRY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  return (await res.json()).token;
}

/**
 * Fetch a manifest by tag or digest. Returns the parsed body plus the canonical
 * `Docker-Content-Digest` header — the digest we pin for an index.
 */
async function getManifest(token, ref) {
  const res = await fetch(`https://${REGISTRY}/v2/${IMAGE}/manifests/${ref}`, {
    headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
  });
  if (!res.ok) throw new Error(`manifest ${ref} failed: HTTP ${res.status}`);
  return { body: await res.json(), digest: res.headers.get('docker-content-digest') };
}

/** Fetch the (JSON) image config blob. fetch follows GHCR's redirect to its CDN. */
async function getConfigBlob(token, digest) {
  const res = await fetch(`https://${REGISTRY}/v2/${IMAGE}/blobs/${digest}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`config blob ${digest} failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const token = await getToken();

  // 1. Resolve `latest` -> the manifest-list digest we pin.
  const { body: index, digest: indexDigest } = await getManifest(token, TAG);
  if (!indexDigest) throw new Error('registry did not return Docker-Content-Digest for :latest');

  // 2. Pick a concrete platform image (skip the buildx attestation "unknown"
  //    entries) so we can read the revision label from its config.
  const platformManifest = Array.isArray(index.manifests)
    ? index.manifests.find((m) => m.platform?.architecture && m.platform.architecture !== 'unknown')
    : null;
  const configDigest = platformManifest
    ? (await getManifest(token, platformManifest.digest)).body.config.digest // multi-arch index
    : index.config?.digest; // single-arch image: `latest` already is the image manifest
  if (!configDigest) throw new Error('could not locate image config for :latest');

  // 3. Read the commit the image was built from, and form its short-sha tag.
  const config = await getConfigBlob(token, configDigest);
  const revision = config.config?.Labels?.[REVISION_LABEL];
  if (!revision) throw new Error(`image is missing the ${REVISION_LABEL} label`);
  const shortTag = `sha-${revision.slice(0, 7)}`;

  // 4. Cross-check: the sha-<short> tag must resolve to the same digest as
  //    `latest`. If not, `latest` was re-pointed mid-run or the tag scheme
  //    changed — refuse rather than write an inconsistent pin.
  const { digest: shortDigest } = await getManifest(token, shortTag);
  if (shortDigest !== indexDigest) {
    throw new Error(
      `consistency check failed: ${shortTag} -> ${shortDigest} but ${TAG} -> ${indexDigest}`,
    );
  }

  const newRef = `${REGISTRY}/${IMAGE}:${shortTag}@${indexDigest}`;

  // 5. Rewrite the pin (or report no-op / dry-run).
  const source = await readFile(SPEC_PATH, 'utf8');
  const match = source.match(PIN_RE);
  if (!match) throw new Error(`could not find DEFAULT_PREVIEW_IMAGE in ${SPEC_PATH}`);
  const currentRef = match[2];

  if (currentRef === newRef) {
    console.log(`Already up to date:\n  ${currentRef}`);
    return;
  }
  console.log(`Current: ${currentRef}`);
  console.log(`Latest:  ${newRef}`);
  if (dryRun) {
    console.log('\n(--dry-run) not writing.');
    return;
  }
  await writeFile(SPEC_PATH, source.replace(PIN_RE, `$1${newRef}$3`));
  console.log(`\nUpdated ${SPEC_PATH.replace(`${process.cwd()}/`, '')}`);
}

main().catch((err) => {
  console.error(`update-preview-image: ${err.message}`);
  process.exit(1);
});
