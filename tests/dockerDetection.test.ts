import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DOCKER_INSTALL_URL,
  PullProgressAggregator,
  classifyDockerProbe,
  dockerDesktopLaunch,
  dockerRemediation,
  formatPullStatus,
} from '../src/dockerDetection';

describe('classifyDockerProbe', () => {
  it('is available when the daemon answered the ping (no error)', () => {
    assert.deepEqual(classifyDockerProbe({ pingError: undefined }), { kind: 'available' });
    assert.deepEqual(classifyDockerProbe({ pingError: null }), { kind: 'available' });
  });

  it('is notInstalled when the socket is absent and the CLI is not on PATH', () => {
    const error = Object.assign(new Error('connect ENOENT /var/run/docker.sock'), {
      code: 'ENOENT',
    });
    assert.deepEqual(classifyDockerProbe({ pingError: error, cliDetected: false }), {
      kind: 'notInstalled',
    });
  });

  it('is notRunning when the socket exists but nothing is listening', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
      code: 'ECONNREFUSED',
    });
    assert.deepEqual(classifyDockerProbe({ pingError: error }), { kind: 'notRunning' });
  });

  it('is notRunning when the CLI is installed even if the socket is missing (daemon stopped)', () => {
    // Docker Desktop stopped: the CLI is on PATH but its managed socket is gone,
    // so the raw code (ENOENT) would read as "not installed" without the hint.
    const error = Object.assign(new Error('connect ENOENT /var/run/docker.sock'), {
      code: 'ENOENT',
    });
    assert.deepEqual(classifyDockerProbe({ pingError: error, cliDetected: true }), {
      kind: 'notRunning',
    });
  });

  it('is unknown for an unrecognized failure, carrying the detail', () => {
    const error = Object.assign(new Error('permission denied while trying to connect'), {
      code: 'EACCES',
    });
    assert.deepEqual(classifyDockerProbe({ pingError: error }), {
      kind: 'unknown',
      detail: 'permission denied while trying to connect',
    });
  });
});

describe('dockerRemediation', () => {
  it('has nothing to remediate when Docker is available', () => {
    assert.equal(dockerRemediation({ kind: 'available' }), undefined);
  });

  it('offers an Install Docker action pointing at the install docs when not installed', () => {
    const remediation = dockerRemediation({ kind: 'notInstalled' });
    assert.ok(remediation);
    assert.match(remediation.message, /install/i);
    assert.deepEqual(remediation.action, {
      kind: 'openUrl',
      label: 'Install Docker',
      url: DOCKER_INSTALL_URL,
    });
  });

  it('offers a Start Docker Desktop launch action when installed but stopped', () => {
    const remediation = dockerRemediation({ kind: 'notRunning' });
    assert.ok(remediation);
    assert.match(remediation.message, /start/i);
    assert.deepEqual(remediation.action, {
      kind: 'launchDockerDesktop',
      label: 'Start Docker Desktop',
    });
  });

  it('surfaces the raw detail (with no action) for an unknown failure', () => {
    const remediation = dockerRemediation({ kind: 'unknown', detail: 'permission denied' });
    assert.ok(remediation);
    assert.match(remediation.message, /permission denied/);
    assert.equal(remediation.action, undefined);
  });
});

describe('dockerDesktopLaunch', () => {
  it('opens the Docker app via `open -a` on macOS', () => {
    assert.deepEqual(dockerDesktopLaunch('darwin'), { command: 'open', args: ['-a', 'Docker'] });
  });

  it('points at the Docker Desktop executable under %ProgramFiles% on Windows', () => {
    assert.deepEqual(dockerDesktopLaunch('win32', 'D:\\Programs'), {
      command: 'D:\\Programs\\Docker\\Docker\\Docker Desktop.exe',
      args: [],
    });
  });

  it('falls back to the standard Program Files path when %ProgramFiles% is unset', () => {
    assert.deepEqual(dockerDesktopLaunch('win32'), {
      command: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      args: [],
    });
    // An empty string is treated as unset rather than producing a bare "\\Docker" path.
    assert.equal(dockerDesktopLaunch('win32', '')?.command.startsWith('C:\\Program Files'), true);
  });

  it('has no known launch command on Linux (engine-only) or other platforms', () => {
    assert.equal(dockerDesktopLaunch('linux'), undefined);
    assert.equal(dockerDesktopLaunch('aix'), undefined);
  });
});

describe('formatPullStatus', () => {
  it('renders a percentage for a layer with a known total, so the download reads as progressing', () => {
    assert.equal(
      formatPullStatus({ status: 'Downloading', id: 'a1b2c3d4', progressDetail: { current: 45, total: 90 } }),
      'Downloading a1b2c3d4 — 50%',
    );
  });

  it('clamps the percentage into 0–100 for out-of-range progress details', () => {
    assert.equal(
      formatPullStatus({ status: 'Downloading', progressDetail: { current: 120, total: 100 } }),
      'Downloading — 100%',
    );
  });

  it('falls back to status + layer id when there is no measurable progress', () => {
    assert.equal(formatPullStatus({ status: 'Extracting', id: 'a1b2c3d4' }), 'Extracting a1b2c3d4');
    assert.equal(formatPullStatus({ status: 'Pull complete' }), 'Pull complete');
  });

  it('ignores an event with no status', () => {
    assert.equal(formatPullStatus({}), undefined);
    assert.equal(formatPullStatus({ status: '   ' }), undefined);
  });

  it('ignores a zero-total layer rather than dividing by zero', () => {
    assert.equal(
      formatPullStatus({ status: 'Waiting', id: 'a1b2c3d4', progressDetail: { current: 0, total: 0 } }),
      'Waiting a1b2c3d4',
    );
  });
});

describe('PullProgressAggregator', () => {
  it('reports no percent until a layer reveals a download total', () => {
    const aggregate = new PullProgressAggregator();
    assert.equal(aggregate.add({ status: 'Pulling fs layer', id: 'a' }).percent, undefined);
    const snapshot = aggregate.add({ status: 'Waiting', id: 'b' });
    assert.equal(snapshot.percent, undefined);
    assert.equal(snapshot.layersTotal, 2);
    assert.equal(snapshot.layersDone, 0);
  });

  it('aggregates download bytes across layers as their totals arrive incrementally', () => {
    const aggregate = new PullProgressAggregator();
    aggregate.add({ status: 'Downloading', id: 'a', progressDetail: { current: 25, total: 100 } });
    // Only layer a is sized so far: 50/100 = 50%.
    assert.equal(
      aggregate.add({ status: 'Downloading', id: 'a', progressDetail: { current: 50, total: 100 } }).percent,
      50,
    );
    // Layer b joins with its own total; overall = (50 + 0) / (100 + 100) = 25%.
    const snapshot = aggregate.add({ status: 'Downloading', id: 'b', progressDetail: { current: 0, total: 100 } });
    assert.equal(snapshot.percent, 25);
    assert.equal(snapshot.layersTotal, 2);
  });

  it('keeps the percent on the download basis after a layer moves to extraction', () => {
    const aggregate = new PullProgressAggregator();
    aggregate.add({ status: 'Downloading', id: 'a', progressDetail: { current: 100, total: 100 } });
    // Extracting reports the much larger *uncompressed* size; it must not become
    // the denominator, so the layer stays counted as its 100/100 download.
    const snapshot = aggregate.add({ status: 'Extracting', id: 'a', progressDetail: { current: 10, total: 100000 } });
    assert.equal(snapshot.percent, 100);
  });

  it('counts a cached "Already exists" layer as done with no bytes', () => {
    const aggregate = new PullProgressAggregator();
    aggregate.add({ status: 'Downloading', id: 'a', progressDetail: { current: 50, total: 100 } });
    const snapshot = aggregate.add({ status: 'Already exists', id: 'b' });
    assert.equal(snapshot.layersTotal, 2);
    assert.equal(snapshot.layersDone, 1);
    // b contributes no bytes to the denominator; the percent stays a's 50/100.
    assert.equal(snapshot.percent, 50);
  });

  it('marks a layer done on Pull complete and tops its bytes off to 100%', () => {
    const aggregate = new PullProgressAggregator();
    aggregate.add({ status: 'Downloading', id: 'a', progressDetail: { current: 80, total: 100 } });
    const snapshot = aggregate.add({ status: 'Pull complete', id: 'a' });
    assert.equal(snapshot.percent, 100);
    assert.equal(snapshot.layersDone, 1);
  });

  it('ignores events without a layer id', () => {
    const aggregate = new PullProgressAggregator();
    const snapshot = aggregate.add({ status: 'Downloading', progressDetail: { current: 10, total: 100 } });
    assert.equal(snapshot.layersTotal, 0);
    assert.equal(snapshot.percent, undefined);
  });
});
