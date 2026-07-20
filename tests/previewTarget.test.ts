import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { isPreviewableQid, isPreviewableType, resolvePreviewTarget } from '../src/previewTarget';

const tempRoots: string[] = [];

/** Scaffold a minimal PrairieLearn course tree in a throwaway temp directory. */
async function makeCourse(options: {
  /** qids (possibly nested with `/`) that should each get an `info.json`. */
  questions: string[];
  /** Extra empty files to create, relative to the course root. */
  extraFiles?: string[];
  /** Omit the course's `infoCourse.json` to model a not-a-course tree. */
  withoutCourseInfo?: boolean;
}): Promise<string> {
  const courseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-target-'));
  tempRoots.push(courseRoot);

  if (!options.withoutCourseInfo) {
    await fs.writeFile(path.join(courseRoot, 'infoCourse.json'), JSON.stringify({ name: 'TEST 101' }));
  }

  for (const qid of options.questions) {
    const questionDir = path.join(courseRoot, 'questions', ...qid.split('/'));
    await fs.mkdir(questionDir, { recursive: true });
    await fs.writeFile(path.join(questionDir, 'info.json'), JSON.stringify({ title: `Title of ${qid}`, type: 'v3' }));
    await fs.writeFile(path.join(questionDir, 'question.html'), '<pl-question-panel></pl-question-panel>');
    await fs.writeFile(path.join(questionDir, 'server.py'), 'def generate(data):\n    pass\n');
  }

  for (const rel of options.extraFiles ?? []) {
    const target = path.join(courseRoot, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '');
  }

  return courseRoot;
}

after(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe('isPreviewableQid', () => {
  it('accepts plain and nested qids', () => {
    assert.equal(isPreviewableQid('arithmetic'), true);
    assert.equal(isPreviewableQid('topic/sub/q1'), true);
  });

  it('rejects empty, absolute, traversal, and backslash qids', () => {
    assert.equal(isPreviewableQid(''), false);
    assert.equal(isPreviewableQid('/etc/passwd'), false);
    assert.equal(isPreviewableQid('../secret'), false);
    assert.equal(isPreviewableQid('topic/../../escape'), false);
    assert.equal(isPreviewableQid('bad\\qid'), false);
    assert.equal(isPreviewableQid('topic//q1'), false);
  });
});

describe('resolvePreviewTarget', () => {
  let courseRoot: string;

  beforeEach(async () => {
    courseRoot = await makeCourse({
      questions: ['arithmetic', 'topic/sub/q1'],
      extraFiles: ['elements/pl-thing/pl-thing.py', 'questions/arithmetic/clientFilesQuestion/data.csv'],
    });
  });

  it('resolves a question from any of its files', async () => {
    for (const file of ['question.html', 'server.py', 'info.json']) {
      const target = await resolvePreviewTarget(path.join(courseRoot, 'questions', 'arithmetic', file), [courseRoot]);
      assert.deepEqual(target, {
        courseRoot,
        qid: 'arithmetic',
        type: 'v3',
        title: 'Title of arithmetic',
      });
    }
  });

  it('resolves a deeply nested qid', async () => {
    const target = await resolvePreviewTarget(
      path.join(courseRoot, 'questions', 'topic', 'sub', 'q1', 'question.html'),
      [courseRoot],
    );
    assert.deepEqual(target, {
      courseRoot,
      qid: 'topic/sub/q1',
      type: 'v3',
      title: 'Title of topic/sub/q1',
    });
  });

  it('resolves from a file nested under the question (e.g. clientFilesQuestion)', async () => {
    const target = await resolvePreviewTarget(
      path.join(courseRoot, 'questions', 'arithmetic', 'clientFilesQuestion', 'data.csv'),
      [courseRoot],
    );
    assert.deepEqual(target, {
      courseRoot,
      qid: 'arithmetic',
      type: 'v3',
      title: 'Title of arithmetic',
    });
  });

  it('walks up to the nearest ancestor infoCourse.json when the workspace is the repo root', async () => {
    // The workspace folder is a parent of the course, mirroring a multi-course repo.
    const repoRoot = path.dirname(courseRoot);
    const target = await resolvePreviewTarget(path.join(courseRoot, 'questions', 'arithmetic', 'server.py'), [
      repoRoot,
    ]);
    assert.deepEqual(target, {
      courseRoot,
      qid: 'arithmetic',
      type: 'v3',
      title: 'Title of arithmetic',
    });
  });

  it('returns null for a course-level file outside questions/ (e.g. an element)', async () => {
    const target = await resolvePreviewTarget(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'), [
      courseRoot,
    ]);
    assert.equal(target, null);
  });

  it('returns null for infoCourse.json itself and other non-question files', async () => {
    assert.equal(await resolvePreviewTarget(path.join(courseRoot, 'infoCourse.json'), [courseRoot]), null);
  });

  it('returns null when no ancestor infoCourse.json exists', async () => {
    const orphan = await makeCourse({
      questions: ['arithmetic'],
      withoutCourseInfo: true,
    });
    const target = await resolvePreviewTarget(path.join(orphan, 'questions', 'arithmetic', 'server.py'), [orphan]);
    assert.equal(target, null);
  });

  it('returns null when the file is not inside any workspace folder', async () => {
    const elsewhere = await makeCourse({ questions: ['arithmetic'] });
    const target = await resolvePreviewTarget(path.join(elsewhere, 'questions', 'arithmetic', 'server.py'), [
      courseRoot,
    ]);
    assert.equal(target, null);
  });
});

describe('isPreviewableType', () => {
  it('accepts all six Source Question Types and an unknown/undefined type', () => {
    for (const type of ['v3', 'Calculation', 'MultipleChoice', 'Checkbox', 'File', 'MultipleTrueFalse']) {
      assert.equal(isPreviewableType(type), true, `${type} is supported by experimental-1`);
    }
    // An undetermined type is attempted rather than pre-emptively refused.
    assert.equal(isPreviewableType(undefined), true);
  });

  it('refuses a type outside the Standalone Preview Server contract', () => {
    assert.equal(isPreviewableType('ExternalCustomType'), false);
  });
});

describe('resolvePreviewTarget — question type', () => {
  /** Write a question whose info.json holds an arbitrary raw body. */
  async function courseWithQuestion(qid: string, rawInfoJson: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-type-'));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, 'infoCourse.json'), JSON.stringify({ name: 'TEST 101' }));
    const questionDir = path.join(root, 'questions', ...qid.split('/'));
    await fs.mkdir(questionDir, { recursive: true });
    await fs.writeFile(path.join(questionDir, 'info.json'), rawInfoJson);
    await fs.writeFile(path.join(questionDir, 'question.html'), '');
    return root;
  }

  it('surfaces the info.json type for a v3 (Freeform) question', async () => {
    const root = await courseWithQuestion('arithmetic', JSON.stringify({ type: 'v3' }));
    const target = await resolvePreviewTarget(path.join(root, 'questions', 'arithmetic', 'question.html'), [root]);
    assert.equal(target?.type, 'v3');
  });

  it('surfaces a legacy Source Question Type so the controller can render it natively', async () => {
    const root = await courseWithQuestion('legacy', JSON.stringify({ type: 'Calculation' }));
    const target = await resolvePreviewTarget(path.join(root, 'questions', 'legacy', 'info.json'), [root]);
    assert.equal(target?.type, 'Calculation');
  });

  it('leaves the type undefined when info.json omits it', async () => {
    const root = await courseWithQuestion('untyped', JSON.stringify({ title: 'no type here' }));
    const target = await resolvePreviewTarget(path.join(root, 'questions', 'untyped', 'question.html'), [root]);
    assert.equal(target?.qid, 'untyped');
    assert.equal(target?.type, undefined);
  });

  it('leaves the type undefined when info.json is unparseable', async () => {
    const root = await courseWithQuestion('broken', '{ this is not json');
    const target = await resolvePreviewTarget(path.join(root, 'questions', 'broken', 'question.html'), [root]);
    assert.equal(target?.qid, 'broken');
    assert.equal(target?.type, undefined);
  });

  it('surfaces the info.json title so the panel tab can name the question', async () => {
    const root = await courseWithQuestion('arithmetic', JSON.stringify({ title: 'Random arithmetic', type: 'v3' }));
    const target = await resolvePreviewTarget(path.join(root, 'questions', 'arithmetic', 'question.html'), [root]);
    assert.equal(target?.title, 'Random arithmetic');
  });

  it('leaves the title undefined when info.json omits it', async () => {
    const root = await courseWithQuestion('untitled', JSON.stringify({ type: 'v3' }));
    const target = await resolvePreviewTarget(path.join(root, 'questions', 'untitled', 'question.html'), [root]);
    assert.equal(target?.qid, 'untitled');
    assert.equal(target?.title, undefined);
  });

  it('leaves the title undefined when info.json is unparseable', async () => {
    const root = await courseWithQuestion('broken', '{ this is not json');
    const target = await resolvePreviewTarget(path.join(root, 'questions', 'broken', 'question.html'), [root]);
    assert.equal(target?.title, undefined);
  });
});
