// ════════════════════════════════════════════
// WEBFLOW LIST NORMALIZER (server-side guarantee)
//
// Webflow's rich text field only understands ONE list shape:
//
//   <ul role="list"><li role="listitem">inline text</li>…</ul>
//
// sitting directly at the top level of the body. Anything else is silently
// dropped by the Webflow API — the whole list disappears. The shapes we see
// from the editor / pasted Google Docs content that trigger this:
//
//   • list wrapped in another element     <b id="docs-internal-guid…"><ul>…
//                                          <div><ol>…   <span><ul>…
//   • block tags inside list items        <li><p>text</p></li>   <li><div>…
//   • nested (indented) lists             <li>a<ul><li>b</li></ul></li>
//                                          <ul><li>a</li><ul><li>b</li></ul></ul>
//   • foreign attributes                  <li dir="ltr" style="…">
//   • one single-item list per bullet     <ul><li>a</li></ul><ul><li>b</li></ul>
//   • stray <li> with no parent list
//
// We parse the HTML and rewrite ONLY the top-level blocks that contain a list;
// every other block (widgets, embeds, tables, figures, plain paragraphs) is
// copied byte-for-byte from the input. Idempotent.
// ════════════════════════════════════════════
import { parseDocument } from 'htmlparser2';
import render from 'dom-serializer';
import { Element, Text } from 'domhandler';

const LIST_TAGS = new Set(['ul', 'ol']);
// Block wrappers whose children should be flattened into a list item's text.
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Never look inside these — they are widgets / embeds / media.
const OPAQUE_TAGS = new Set(['table', 'figure', 'iframe', 'script', 'style', 'video', 'embed', 'object', 'noscript', 'svg']);

const PARSE_OPTS = { withStartIndices: true, withEndIndices: true, decodeEntities: false };
const RENDER_OPTS = { decodeEntities: false, encodeEntities: false };

const isTag = (n) => n && (n.type === 'tag' || n.type === 'script' || n.type === 'style');
const isList = (n) => isTag(n) && LIST_TAGS.has(n.name);
const isLi = (n) => isTag(n) && n.name === 'li';

function isOpaque(n) {
  if (!isTag(n)) return false;
  if (OPAQUE_TAGS.has(n.name)) return true;
  const a = n.attribs || {};
  if ('data-rt-embed-type' in a) return true;
  // same widget detection as protectWidgets()
  return n.name === 'div' && /(?:w-embed|w-widget|widget|embed)/i.test(a.class || '');
}

function containsList(n) {
  if (!isTag(n) || isOpaque(n)) return false;
  return n.children.some(c => isList(c) || isLi(c) || containsList(c));
}

const isBlank = (html) => html.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;|&#160;/gi, ' ').trim() === '';

function trimBreaks(html) {
  return html
    .replace(/^(?:\s|&nbsp;|<br\s*\/?>)+/i, '')
    .replace(/(?:\s|&nbsp;|<br\s*\/?>)+$/i, '');
}

// ── Collect the items of a list as flat inline-HTML strings ──
// Nested lists are flattened into following items (Webflow has no nested lists).
function collectItems(list, items) {
  for (const child of list.children) {
    if (isLi(child)) collectLi(child, items);
    else if (isList(child)) collectItems(child, items);       // <ul><ul>…</ul></ul>
    else if (isTag(child) && containsList(child)) collectItems(child, items);
    else {
      // stray inline content directly inside <ul> — keep it as its own item
      const html = trimBreaks(render(child, RENDER_OPTS));
      if (!isBlank(html)) items.push(html);
    }
  }
  return items;
}

function collectLi(li, items) {
  const nested = [];
  const parts = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (isList(n)) { collectItems(n, nested); continue; }
      if (isLi(n)) { collectLi(n, nested); continue; }        // <li><li>…
      if (isTag(n) && !isOpaque(n) && (BLOCK_TAGS.has(n.name) || containsList(n))) {
        // unwrap <p>/<div>/… inside a list item; keep block boundaries as a space
        parts.push(' ');
        walk(n.children);
        parts.push(' ');
        continue;
      }
      parts.push(render(n, RENDER_OPTS));
    }
  };
  walk(li.children);
  const html = trimBreaks(parts.join('').replace(/\s{2,}/g, ' '));
  if (!isBlank(html)) items.push(html);
  items.push(...nested);
  return items;
}

// ── Pull lists out of wrapper elements ──
// <div>intro<ul>…</ul>outro</div>  →  [<div>intro</div>, <ul>…</ul>, <div>outro</div>]
function hoist(node) {
  if (isList(node) || !containsList(node)) return [node];
  const out = [];
  let current = null;
  const flush = () => {
    if (current && !isBlank(render(current.children, RENDER_OPTS))) out.push(current);
    current = null;
  };
  let orphanLis = null;
  const flushLis = () => {
    if (orphanLis) out.push(new Element('ul', {}, orphanLis));
    orphanLis = null;
  };
  for (const child of node.children) {
    for (const part of hoist(child)) {
      if (isLi(part)) { flush(); (orphanLis ||= []).push(part); continue; }
      if (orphanLis && part.type === 'text' && !part.data.trim()) continue;
      flushLis();
      if (isList(part)) { flush(); out.push(part); continue; }
      if (!current) current = new Element(node.name, { ...node.attribs }, []);
      current.children.push(part);
    }
  }
  flushLis();
  flush();
  return out;
}

function renderList(type, items) {
  return `<${type} role="list">${items.map(i => `<li role="listitem">${i}</li>`).join('')}</${type}>`;
}

export function normalizeListsForWebflow(html) {
  if (typeof html !== 'string' || !/<(?:ul|ol|li)\b/i.test(html)) return html;

  const doc = parseDocument(html, PARSE_OPTS);
  const top = doc.children;

  // Output is a sequence of raw strings and list blocks; adjacent lists of the
  // same type (only whitespace between) are merged into one.
  const out = [];
  let lastList = null;          // { type, items } of the most recent emitted list
  let gap = '';                 // whitespace seen since lastList

  const emitRaw = (s) => {
    if (lastList && !s.trim()) { gap += s; return; }
    if (lastList) { out.push(renderList(lastList.type, lastList.items)); if (gap) out.push(gap); lastList = null; gap = ''; }
    out.push(s);
  };
  const emitList = (type, items) => {
    if (!items.length) return;
    if (lastList && lastList.type === type) { lastList.items.push(...items); gap = ''; return; }
    if (lastList) { out.push(renderList(lastList.type, lastList.items)); if (gap) out.push(gap); }
    lastList = { type, items: [...items] };
    gap = '';
  };

  let orphanLis = [];
  const flushOrphans = () => {
    if (orphanLis.length) emitList('ul', orphanLis.flatMap(li => collectLi(li, [])));
    orphanLis = [];
  };

  for (let i = 0; i < top.length; i++) {
    const node = top[i];
    const start = node.startIndex;
    const end = i + 1 < top.length ? top[i + 1].startIndex : html.length;
    const raw = html.slice(start, end);

    if (isLi(node)) { orphanLis.push(node); continue; }
    if (orphanLis.length && node.type === 'text' && !raw.trim()) continue;
    flushOrphans();

    // stray close tag the parser turned into an empty element (e.g. "</p>")
    if (isTag(node) && raw.startsWith('</') && !node.children.length) continue;

    if (isList(node)) { emitList(node.name, collectItems(node, [])); continue; }

    if (containsList(node)) {
      for (const part of hoist(node)) {
        if (isList(part)) emitList(part.name, collectItems(part, []));
        else emitRaw(render(part, RENDER_OPTS));
      }
      continue;
    }

    // Parser auto-closed this block because a list opened inside it
    // (e.g. "<p>intro<ul>"), or it's the stray "</p>" left behind. Re-render
    // the auto-closed block properly and drop the empty stray.
    if (isTag(node) && node.endIndex !== end - 1 && !isOpaque(node)) {
      const rendered = render(node, RENDER_OPTS);
      if (!isBlank(rendered.replace(/<[^>]+>/g, ''))) emitRaw(rendered);
      continue;
    }

    emitRaw(raw);
  }
  flushOrphans();
  if (lastList) { out.push(renderList(lastList.type, lastList.items)); if (gap) out.push(gap); }

  return out.join('');
}
