import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeStartupProgress } from '../src/startupProgress';

describe('describeStartupProgress', () => {
  const statuses = (progress?: Parameters<typeof describeStartupProgress>[0]) =>
    describeStartupProgress(progress).steps.map((step) => step.status);

  it('marks the first step active before any event, so a loading indicator always shows', () => {
    const view = describeStartupProgress();

    assert.equal(view.heading, 'Starting preview…');
    assert.equal(view.percent, undefined);
    assert.deepEqual(
      view.steps.map((step) => step.label),
      ['Downloading image', 'Starting container', 'Launching preview server'],
    );
    assert.deepEqual(statuses(), ['active', 'pending', 'pending']);
  });

  it('marks the download step active with a determinate bar and a layer-count note during a pull', () => {
    const view = describeStartupProgress({
      phase: 'pullingImage',
      percent: 46,
      layersDone: 3,
      layersTotal: 11,
      detail: 'Extracting f957de186774',
    });

    assert.equal(view.percent, 46); // the smooth overall download percentage drives the bar
    assert.deepEqual(
      view.steps.map((step) => step.status),
      ['active', 'pending', 'pending'],
    );
    assert.equal(view.steps[0].note, '3/11 layers');
    assert.equal(view.detail, 'Extracting f957de186774'); // the raw Docker status line
  });

  it('shows 0% and a layer count at the very start of the download', () => {
    const view = describeStartupProgress({ phase: 'pullingImage', percent: 0, layersDone: 0, layersTotal: 11 });

    assert.equal(view.percent, 0);
    assert.equal(view.steps[0].note, '0/11 layers');
  });

  it('stays indeterminate until the first layer is announced', () => {
    const view = describeStartupProgress({ phase: 'pullingImage' });

    assert.equal(view.percent, undefined);
    assert.equal(view.steps[0].note, undefined);
    assert.equal(view.steps[0].status, 'active');
  });

  it('marks the start step active with an indeterminate bar while the container starts', () => {
    const view = describeStartupProgress({ phase: 'startingContainer' });

    assert.equal(view.percent, undefined);
    assert.deepEqual(
      view.steps.map((step) => step.status),
      ['done', 'active', 'pending'],
    );
    assert.equal(view.steps[1].note, undefined);
  });

  it('marks the wait step active with an elapsed-seconds note and no percent', () => {
    const view = describeStartupProgress({ phase: 'waitingForServer', elapsedMs: 6200, timeoutMs: 60000 });

    assert.equal(view.percent, undefined);
    assert.equal(view.detail, undefined); // the Docker status line only shows during the pull
    assert.deepEqual(
      view.steps.map((step) => step.status),
      ['done', 'done', 'active'],
    );
    assert.equal(view.steps[2].note, '6s');
  });
});
