import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeStartupProgress } from '../src/startupProgress';

describe('describeStartupProgress', () => {
  const statuses = (progress?: Parameters<typeof describeStartupProgress>[0]) =>
    describeStartupProgress(progress).steps.map((step) => step.status);

  it('shows all three phases pending with an indeterminate bar before any event', () => {
    const view = describeStartupProgress();

    assert.equal(view.heading, 'Starting preview…');
    assert.equal(view.percent, undefined);
    assert.deepEqual(
      view.steps.map((step) => step.label),
      ['Downloading image', 'Starting container', 'Waiting for server'],
    );
    assert.deepEqual(statuses(), ['pending', 'pending', 'pending']);
  });

  it('marks the download step active with a percent note and a determinate bar during a pull', () => {
    const view = describeStartupProgress({
      phase: 'pullingImage',
      percent: 45,
      layersDone: 2,
      layersTotal: 5,
    });

    assert.equal(view.percent, 45);
    assert.deepEqual(
      view.steps.map((step) => step.status),
      ['active', 'pending', 'pending'],
    );
    assert.equal(view.steps[0].note, '45%');
  });

  it('falls back to a layer count while the pull percentage is not yet known', () => {
    const view = describeStartupProgress({ phase: 'pullingImage', layersDone: 3, layersTotal: 8 });

    assert.equal(view.percent, undefined); // indeterminate until a total arrives
    assert.equal(view.steps[0].note, '3/8 layers');
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
    assert.deepEqual(
      view.steps.map((step) => step.status),
      ['done', 'done', 'active'],
    );
    assert.equal(view.steps[2].note, '6s');
  });
});
