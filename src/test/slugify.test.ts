import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../dataSource/jsonlTail';

test('slugify handles Windows paths', () => {
  assert.equal(slugify('c:\\Users\\Foo\\my project'), 'c--Users-Foo-my-project');
});

test('slugify handles macOS paths', () => {
  assert.equal(slugify('/Users/Foo/my project'), '-Users-Foo-my-project');
});

test('slugify collapses internal whitespace runs', () => {
  assert.equal(slugify('/Users/Foo Bar/project  one'), '-Users-Foo-Bar-project-one');
});

test('slugify handles UNC paths', () => {
  assert.equal(slugify('\\\\server\\share\\my project'), '--server-share-my-project');
});

test('slugify handles tabs and other whitespace', () => {
  assert.equal(slugify('/Users/Foo\tBar/path'), '-Users-Foo-Bar-path');
});
