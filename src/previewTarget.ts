import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Preview-target resolution: from the active file path, work out which course
 * and question the editor-following preview should render. Kept free of any
 * `vscode`/dockerode import so it is unit-testable against a filesystem fixture
 * (mirroring the `PrairieLearn-Render-Demo` POC's `previewDiscovery` tests).
 *
 * The rendering itself is owned by the container runtime; this module only maps
 * `(activeFilePath, workspaceFolders) → { courseRoot, qid } | null`, where the
 * course is the nearest ancestor holding an `infoCourse.json` and the qid is the
 * question directory under `questions/` that the file belongs to.
 */

/** Marks a directory as a PrairieLearn course root. */
export const COURSE_INFO_FILE = 'infoCourse.json';
/** Marks a directory as a PrairieLearn question. */
export const QUESTION_INFO_FILE = 'info.json';
/** Directory under the course root that holds questions. */
export const QUESTIONS_DIR = 'questions';

/** The `info.json` `type` value of a v3/Freeform question — the only previewable kind. */
export const FREEFORM_QUESTION_TYPE = 'v3';

/** A resolved preview target: which course to mount and which qid to render. */
export interface PreviewTarget {
  /** Absolute course root (the directory containing `infoCourse.json`). */
  readonly courseRoot: string;
  /** Question id relative to `questions/`, with `/` separators. */
  readonly qid: string;
  /**
   * The question's `info.json` `type`, or `undefined` when it is absent or the
   * file could not be parsed. Drives the "not previewable for this type" state:
   * only v3/Freeform questions render (see {@link isPreviewableType}).
   */
  readonly type?: string;
  /**
   * The question's `info.json` `title`, or `undefined` when it is absent or the
   * file could not be parsed. Names the preview panel's tab (the caller falls
   * back to the {@link qid} when it is missing).
   */
  readonly title?: string;
}

/**
 * Whether a question of this `info.json` `type` can be previewed. Only v3/Freeform
 * (`type: "v3"`) is renderable by the preview server; legacy types (e.g.
 * `Calculation`) are shown as a friendly "not previewable" state instead.
 *
 * An `undefined` type (missing or unparseable `info.json`) is treated as
 * previewable so the render is still attempted — a genuine failure then surfaces
 * as the loud error state rather than being pre-emptively refused here.
 */
export function isPreviewableType(type: string | undefined): boolean {
  return type === undefined || type.toLowerCase() === FREEFORM_QUESTION_TYPE;
}

/**
 * The qid rules shared with the preview server (ported from the POC's
 * `isPreviewableQid`): a non-empty, relative, forward-slashed path whose every
 * segment is a real directory name. This is the traversal guard — a qid that
 * could escape the course tree is rejected before it ever reaches the server.
 */
export function isPreviewableQid(qid: string): boolean {
  const segments = qid.split('/');
  return (
    qid.length > 0 &&
    !qid.startsWith('/') &&
    !qid.includes('\\') &&
    !qid.includes('\0') &&
    !path.isAbsolute(qid) &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('\\') &&
        !segment.includes('\0') &&
        !path.isAbsolute(segment),
    )
  );
}

/**
 * Resolve the preview target for the active file, or `null` when the file is not
 * inside a previewable question.
 *
 * The upward walk is bounded by the workspace folder that contains the file, so
 * resolution never reaches for an `infoCourse.json` outside the opened
 * workspace. A file outside every workspace folder — or one not under a course's
 * `questions/` tree — is `notAQuestion` (an empty preview state upstream).
 */
export async function resolvePreviewTarget(
  activeFilePath: string,
  workspaceFolders: readonly string[],
): Promise<PreviewTarget | null> {
  const boundary = containingFolder(activeFilePath, workspaceFolders);
  if (!boundary) {
    return null;
  }

  const courseRoot = await findCourseRoot(path.dirname(activeFilePath), boundary);
  if (!courseRoot) {
    return null;
  }

  const found = await resolveQid(courseRoot, activeFilePath);
  if (found === null || !isPreviewableQid(found.qid)) {
    return null;
  }

  const info = await readQuestionInfo(found.questionDir);
  return { courseRoot, qid: found.qid, type: info.type, title: info.title };
}

/** The deepest workspace folder that contains `filePath`, if any. */
function containingFolder(filePath: string, workspaceFolders: readonly string[]): string | undefined {
  return workspaceFolders
    .filter((folder) => isInside(folder, filePath))
    .sort((a, b) => b.length - a.length)[0];
}

/** Walk up from `startDir` (inclusive) to `boundary` looking for `infoCourse.json`. */
async function findCourseRoot(startDir: string, boundary: string): Promise<string | null> {
  let dir = startDir;
  for (;;) {
    if (await isFile(path.join(dir, COURSE_INFO_FILE))) {
      return dir;
    }
    if (dir === boundary) {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Given the course root and the active file, find the nearest ancestor directory
 * under `questions/` that holds an `info.json` — that directory *is* the
 * question, and its path under `questions/` is the qid. Returns the qid together
 * with the question directory (so its `info.json` `type` can be read), or `null`
 * when the file is not under a question at all.
 */
async function resolveQid(
  courseRoot: string,
  activeFilePath: string,
): Promise<{ qid: string; questionDir: string } | null> {
  const questionsRoot = path.join(courseRoot, QUESTIONS_DIR);
  if (!isInside(questionsRoot, activeFilePath)) {
    return null;
  }

  let dir = path.dirname(activeFilePath);
  while (dir !== questionsRoot && isInside(questionsRoot, dir)) {
    if (await isFile(path.join(dir, QUESTION_INFO_FILE))) {
      return { qid: path.relative(questionsRoot, dir).split(path.sep).join('/'), questionDir: dir };
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** The fields we read off a question's `info.json` (both optional). */
interface QuestionInfo {
  /** Display title for the panel tab; see {@link PreviewTarget.title}. */
  readonly title?: string;
  /** Question type gating previewability; see {@link PreviewTarget.type}. */
  readonly type?: string;
}

/**
 * Read the question's `info.json` `title` and `type`, each `undefined` when the
 * field is absent or the file cannot be read/parsed. A malformed or unreadable
 * `info.json` is not an error here — the render is still attempted and any real
 * failure surfaces downstream as the loud error state.
 */
async function readQuestionInfo(questionDir: string): Promise<QuestionInfo> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(questionDir, QUESTION_INFO_FILE), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { title?: unknown; type?: unknown };
    return { title: cleanString(parsed.title), type: cleanString(parsed.type) };
  } catch {
    return {};
  }
}

/** A trimmed non-empty string, or `undefined` for anything else (missing/blank/non-string). */
function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** True when `child` is `parent` itself or nested beneath it. */
function isInside(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
