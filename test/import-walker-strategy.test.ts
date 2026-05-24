import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectSyncableFiles } from '../src/commands/import.ts';

// Companion to test/import-walker.test.ts. That file pins L002 symlink
// containment for the strategy='markdown' path (the default). This file
// pins strategy='code' behavior — first-sync code import was the path
// that historically dropped --strategy silently (upstream issue #767),
// so the strategy=code walker semantics need their own regression guard.
// Symlink containment cases are duplicated under strategy=code on
// purpose: a future refactor that splits the unified walker into
// per-strategy walkers must not regress the security invariant.

describe('collectSyncableFiles({strategy: code}) — strategy filtering', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-strategy-code-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns code files but not markdown', () => {
    writeFileSync(join(root, 'doc.md'), '# doc\n');
    writeFileSync(join(root, 'main.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'helper.py'), 'def helper(): pass\n');
    writeFileSync(join(root, 'app.java'), 'public class App {}\n');
    writeFileSync(join(root, 'core.c'), 'int main() { return 0; }\n');

    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toContain(join(root, 'main.ts'));
    expect(files).toContain(join(root, 'helper.py'));
    expect(files).toContain(join(root, 'app.java'));
    expect(files).toContain(join(root, 'core.c'));
    expect(files).not.toContain(join(root, 'doc.md'));
  });

  test('recurses into subdirectories', () => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'src', 'lib'));
    writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
    writeFileSync(join(root, 'src', 'lib', 'util.py'), '# util\n');

    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toContain(join(root, 'src', 'main.ts'));
    expect(files).toContain(join(root, 'src', 'lib', 'util.py'));
  });

  test('skips node_modules', () => {
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'node_modules', 'foo'));
    writeFileSync(join(root, 'node_modules', 'foo', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'app.ts'), 'export {};\n');

    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toContain(join(root, 'app.ts'));
    expect(files).not.toContain(join(root, 'node_modules', 'foo', 'index.ts'));
  });

  test('skips hidden directories', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config.ts'), 'export {};\n');
    writeFileSync(join(root, 'app.ts'), 'export {};\n');

    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toContain(join(root, 'app.ts'));
    expect(files.some(f => f.includes(`${root}/.git/`))).toBe(false);
  });
});

describe('collectSyncableFiles({strategy: code}) — symlink containment (L002 parity)', () => {
  // The unified walker at src/commands/import.ts:collectSyncableFiles uses
  // lstatSync + isSymbolicLink() to enforce containment regardless of
  // strategy. These tests assert that invariant under strategy=code so a
  // future refactor that splits the walker can't accidentally remove the
  // skip for one strategy path. Mirrors the strategy=markdown cases in
  // test/import-walker.test.ts.

  let root: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-strategy-code-root-'));
    secretDir = mkdtempSync(join(tmpdir(), 'gbrain-strategy-code-secret-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  test('skips a symlink file pointing outside the source root', () => {
    const secretFile = join(secretDir, 'secret.ts');
    writeFileSync(secretFile, 'export const SECRET = "do not ingest";\n');

    writeFileSync(join(root, 'legit.ts'), 'export const ok = true;\n');
    symlinkSync(secretFile, join(root, 'innocent.ts'));

    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toContain(join(root, 'legit.ts'));
    expect(files).not.toContain(join(root, 'innocent.ts'));
    expect(files).not.toContain(secretFile);
  });

  test('does not descend into a symlinked directory', () => {
    const outsideSub = join(secretDir, 'sub');
    mkdirSync(outsideSub);
    writeFileSync(join(outsideSub, 'external.ts'), 'export const x = 1;\n');

    writeFileSync(join(root, 'legit.ts'), 'export const ok = true;\n');
    symlinkSync(outsideSub, join(root, 'linked-src'));

    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toContain(join(root, 'legit.ts'));
    expect(files).not.toContain(join(root, 'linked-src', 'external.ts'));
    expect(files).not.toContain(join(outsideSub, 'external.ts'));
  });

  test('skips broken symlinks without crashing', () => {
    writeFileSync(join(root, 'legit.ts'), 'export {};\n');
    symlinkSync('/nonexistent/path/to/nowhere', join(root, 'dangling.ts'));

    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toContain(join(root, 'legit.ts'));
    expect(files).not.toContain(join(root, 'dangling.ts'));
  });
});

describe('collectSyncableFiles({strategy: code}) — robustness', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-strategy-code-robust-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns empty array for an empty directory', () => {
    const files = collectSyncableFiles(root, { strategy: 'code' });
    expect(files).toEqual([]);
  });

  test('does not crash on a non-existent directory', () => {
    const ghost = join(root, 'does-not-exist');
    const files = collectSyncableFiles(ghost, { strategy: 'code' });
    expect(files).toEqual([]);
  });

  test('does not crash when an unreadable subdirectory is encountered', () => {
    mkdirSync(join(root, 'normal'));
    writeFileSync(join(root, 'normal', 'a.ts'), 'export {};\n');
    mkdirSync(join(root, 'denied'), { mode: 0o000 });
    try {
      const files = collectSyncableFiles(root, { strategy: 'code' });
      expect(files).toContain(join(root, 'normal', 'a.ts'));
    } finally {
      try { chmodSync(join(root, 'denied'), 0o755); } catch {}
    }
  });
});
