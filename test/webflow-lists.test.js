import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListsForWebflow as norm } from '../webflow-lists.js';

const UL = (...items) => `<ul role="list">${items.map(i => `<li role="listitem">${i}</li>`).join('')}</ul>`;
const OL = (...items) => `<ol role="list">${items.map(i => `<li role="listitem">${i}</li>`).join('')}</ol>`;

test('canonical list is unchanged and idempotent', () => {
  const h = `<p>Intro</p>\n${UL('a', '<strong>b</strong>')}\n<p>End</p>`;
  assert.equal(norm(h), h);
  assert.equal(norm(norm(h)), h);
});

test('strips foreign attributes', () => {
  assert.equal(norm('<ol dir="ltr" style="x"><li dir="ltr" class="c">one</li></ol>'), OL('one'));
});

test('Google Docs paste: list inside <b> wrapper, <p> inside <li>', () => {
  const h = '<b id="docs-internal-guid-1" style="font-weight:normal"><p dir="ltr"><span>Intro</span></p>'
    + '<ul><li dir="ltr"><p dir="ltr"><span>First</span></p></li><li dir="ltr"><p dir="ltr"><span>Second</span></p></li></ul>'
    + '<p><span>Outro</span></p></b>';
  assert.equal(norm(h),
    '<b id="docs-internal-guid-1" style="font-weight:normal"><p dir="ltr"><span>Intro</span></p></b>'
    + UL('<span>First</span>', '<span>Second</span>')
    + '<b id="docs-internal-guid-1" style="font-weight:normal"><p><span>Outro</span></p></b>');
});

test('list wrapped in a div is hoisted', () => {
  assert.equal(norm('<div><ol><li>a</li><li>b</li></ol></div>'), OL('a', 'b'));
});

test('list opened inside a <p>', () => {
  assert.equal(norm('<p>Intro:<ul><li>a</li></ul></p><h2>Next</h2>'), '<p>Intro:</p>' + UL('a') + '<h2>Next</h2>');
});

test('nested lists are flattened', () => {
  assert.equal(norm('<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>'), UL('a', 'a1', 'a2', 'b'));
  assert.equal(norm('<ul><li>a</li><ul><li>a1</li></ul><li>b</li></ul>'), UL('a', 'a1', 'b'));
});

test('<div>/<br> inside list items from the editor', () => {
  assert.equal(norm('<ul><li><div>a</div></li><li>b<br></li><li><br></li></ul>'), UL('a', 'b'));
});

test('adjacent single-item lists are merged; different types are not', () => {
  assert.equal(norm('<ul><li>a</li></ul>\n<ul><li>b</li></ul>'), UL('a', 'b'));
  assert.equal(norm('<ul><li>a</li></ul>\n<ol><li>b</li></ol>'), UL('a') + '\n' + OL('b'));
  assert.equal(norm('<ul><li>a</li></ul><p>x</p><ul><li>b</li></ul>'), UL('a') + '<p>x</p>' + UL('b'));
});

test('stray <li> without a parent list gets wrapped', () => {
  assert.equal(norm('<p>x</p><li>a</li>\n<li>b</li><p>y</p>'), '<p>x</p>' + UL('a', 'b') + '<p>y</p>');
});

test('empty lists are removed', () => {
  assert.equal(norm('<p>x</p><ul><li> </li></ul>'), '<p>x</p>');
});

test('widgets, tables and entities are left byte-for-byte', () => {
  const embed = `<div data-rt-embed-type='true'><ul class="x"><li>keep</li></ul><script>if(a<b){}</script></div>`;
  const table = '<table><tr><td><ul><li>cell</li></ul></td></tr></table>';
  const para = '<p>Tom &amp; Jerry&nbsp;&mdash; "quoted" <a href=\'/x\'>link</a></p>';
  const h = `${embed}${table}${para}<ul><li>A &amp; B</li></ul>`;
  assert.equal(norm(h), `${embed}${table}${para}${UL('A &amp; B')}`);
});

test('html without lists is returned untouched', () => {
  const h = '<p>hello <b>world</p>';
  assert.equal(norm(h), h);
});
