// kp.js — Knuth–Plass justification by encoded text breaks
//
// ----------------------------------------------------------------------------
//
// The classical Knuth–Plass algorithm finds the optimal set of line breaks
// for a paragraph: the set that minimizes a "badness" score summed across
// all lines, where badness penalizes lines stretched or compressed beyond
// their natural width, awkwardly placed hyphens, lines whose last word ought
// not to have hyphenated, and so on. The dynamic program is famous, the
// implementation fits on a page, and the output is gorgeous.
//
// Browsers don't do this. They use a greedy first-fit line breaker because
// it is fast and stateless, and because most web text doesn't need anything
// more. But for justified prose at narrow widths the difference is striking.
// A short line filled greedily is a line padded with awkward gaps; the same
// line, picked with K-P, is the right line to put there.
//
// The interesting question is not the algorithm — it is well known. The
// question is what to do with the answer once you have it. You computed an
// optimal set of break points. Now make the browser respect them.
//
// The traditional way is to hand-paint the layout. Split the paragraph into
// per-line spans, set each line's width, distribute the slack with inline-
// block elements of computed pixel widths. This works. It is also a great
// deal of DOM, and the per-glyph widths are baked into the HTML, so the
// moment a font finishes loading or the column resizes, the painted layout
// disagrees with what the browser would now render. You have to repaint.
//
// The approach in this file does no painting. K-P's decisions are encoded
// as a flat string of ordinary characters and the browser's own line breaker
// runs on it. The encoding has four pieces:
//
//   * Regular space (U+0020) — chosen break point. The browser may wrap here.
//   * No-break space (U+00A0) — rejected break point. The browser may not.
//   * Soft hyphen (U+00AD) — emitted only at chosen hyphenation points;
//     rejected hyphenation candidates are simply absent from the output.
//   * Non-breaking hyphen (U+2011) — replaces real hyphens (U+002D) so the
//     browser doesn't treat compound words as opportunistic break points.
//
// Given a string in which the only legal break points are the K-P-chosen
// ones, the browser's greedy filler is forced to produce K-P's answer. It
// has no other choice. Justification works natively because chosen spaces
// stretch under `text-align: justify` and NBSPs do not. Hyphenation works
// natively too, given `hyphens: manual` and well-placed soft hyphens. We
// never touch a glyph; the browser draws the text.
//
// Practically: a paragraph is one text node. Setting its `nodeValue`
// triggers one reflow. There are no inline-blocks, no per-line wrappers,
// no per-resize repaints. On window resize we recompute the break set —
// cheap, since the canvas-measured glyph widths are already cached — and
// write the new string. The browser does what it is good at.
//
// ----------------------------------------------------------------------------

import {prepareWithSegments, clearCache} from "https://cdn.jsdelivr.net/npm/@chenglou/pretext/+esm"
import Hypher from "https://cdn.jsdelivr.net/npm/hypher/+esm"
import english from "https://cdn.jsdelivr.net/npm/hyphenation.en-us/+esm"

const SOFT_HYPHEN = "\u00AD"
const NON_BREAKING_HYPHEN = "\u2011"
const NBSP = "\u00A0"
const HUGE_BADNESS = 1e10

// The browser's text shaper and canvas's measureText() agree on most
// things but disagree at the sub-pixel level. We shave a couple of pixels
// off the available width so a line K-P thinks "just fits" never overflows
// when the browser actually renders it. Without this margin, sub-pixel
// drift can let a word slip past the column edge, and `overflow-wrap` may
// splat the word mid-character to satisfy the constraint.
const SAFETY_PX = 2

// "How loose can a line get before we'd rather hyphenate?" When the
// stretched space exceeds this much of the natural space width, badness
// picks up an extra quartic penalty on top of the usual cubic. Empirically
// tuned for "feels like a book" on body text.
const MAX_SPACE_RATIO = 1.7

const hypher = new Hypher(english)
const measuringContext = document.createElement("canvas").getContext("2d")

// Per-paragraph state.
//
// We snapshot the original text once, then cache two layers of computed
// work:
//
//   * prep — hyphenation patterns inserted, segments measured by pretext,
//     glyph-to-text-node origins tracked. Depends on font + letter-spacing
//     only. Resizing does not invalidate it.
//
//   * layout — the actual K-P break decisions for a particular width.
//     Cheap to recompute (DP over already-measured segments + a string
//     write).
//
// Three keys handle invalidation:
//
//   * styleEpoch — bumped when a font finishes loading. Forces re-read of
//     computed style and full re-prep.
//   * prepKey — depends on font + letter-spacing. Width-only changes leave
//     prep cached.
//   * layoutKey — depends on prepKey + width. The "is anything to do?" key.
const states = new WeakMap()
const observed = new Set()
const pending = new Set()
let fontEpoch = 0
let raf = null

// ResizeObserver passes the new size in the entry. We do *not* call
// getBoundingClientRect — that would force the browser to flush layout to
// give us a "correct" rect, and after we've just written a bunch of text
// nodes, that flush is exactly the layout thrash we are trying to avoid.
// The width in the entry is what the browser computed during its most
// recent layout; it is current at the moment the callback fires.
const observer = new ResizeObserver(entries => {
  for (const entry of entries) {
    const state = states.get(entry.target)
    if (!state) continue
    const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
    if (Math.abs(w - state.width) < 0.5) continue
    state.width = w
    state.layoutKey = null
    pending.add(entry.target)
  }
  schedule()
})

document.fonts?.addEventListener("loadingdone", () => {
  // Font metrics are now different. Pretext's per-(font, glyph) cache
  // is stale; every paragraph's prep cache is stale.
  fontEpoch++
  clearCache()
  for (const p of observed) {
    const state = states.get(p)
    if (!state) continue
    state.styleEpoch = -1
    state.prepKey = null
    state.layoutKey = null
    pending.add(p)
  }
  schedule()
})

// Public API: register every <p> under `root` and keep them justified
// across resizes and font swaps. Idempotent.
//
// On first pass we read widths and run K-P synchronously, so the page
// paints already-justified rather than flashing a frame of greedy text
// while we wait for the ResizeObserver to fire. The ResizeObserver still
// owns subsequent updates; this just shortcuts the very first layout.
export function justifyAll(root = document) {
  const ps = root.querySelectorAll("p")
  for (const p of ps) justify(p)
  for (const p of ps) {
    const state = states.get(p)
    if (state.width > 0) continue
    state.width = contentBoxWidth(p)
    if (state.width > 0) wrap(p)
  }
}

export function justify(p) {
  if (observed.has(p)) return
  observed.add(p)
  states.set(p, {
    snapshot: null,
    width: 0,
    font: null,
    letterSpacing: 0,
    styleEpoch: -1,
    prep: null,
    prepKey: null,
    layoutKey: null,
  })
  observer.observe(p)
}

// Read an element's content-box width synchronously. ResizeObserver hands
// us this number in its entries, but it fires asynchronously; for the
// initial load we compute the same value from getBoundingClientRect minus
// padding and border. This is a one-shot read at load time, so the layout
// it forces is harmless.
function contentBoxWidth(el) {
  const rect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const borX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)
  return rect.width - padX - borX
}

function schedule() {
  if (raf !== null || pending.size === 0) return
  raf = requestAnimationFrame(() => {
    raf = null
    // No frame budget: process everything in one go. The browser performs
    // one layout at end-of-frame regardless of how many paragraphs we
    // touched. Splitting across frames adds RAF-cycle latency and produces
    // a visible ripple of intermediate states. For a few thousand
    // paragraphs the per-frame work is on the order of tens of milliseconds
    // — one barely-perceptible jank moment is preferable to ten.
    for (const p of pending) wrap(p)
    pending.clear()
  })
}

function wrap(p) {
  if (!p.isConnected) return
  const state = states.get(p)
  if (!state || state.width <= 0) return

  // Snapshot the original text on first run. We mutate text-node values to
  // install K-P output, so we need the originals to recompute from later.
  if (state.snapshot === null) state.snapshot = snapshot(p)

  // Style: read once on first wrap and on font swap. Cached otherwise.
  // Reading getComputedStyle can force a style recalc but not a full
  // layout, and it's gated by styleEpoch so it doesn't happen on resize.
  if (state.styleEpoch !== fontEpoch) {
    const style = getComputedStyle(p)
    state.font = fontShorthand(style)
    state.letterSpacing = lengthPx(style.letterSpacing) ?? 0
    state.styleEpoch = fontEpoch
  }

  const targetWidth = Math.max(0, state.width - SAFETY_PX)
  if (targetWidth <= 0) return

  // Layout key includes width. If neither width nor font changed, we have
  // nothing to do. This is the common case for LiveView class flips and
  // similar incidental updates.
  const layoutKey = `${fontEpoch}|${state.font}|${state.letterSpacing}|${Math.round(targetWidth * 100)}`
  if (state.layoutKey === layoutKey) return
  state.layoutKey = layoutKey

  // Prep key is width-independent. Width-only changes (the resize case)
  // skip the expensive hypher + pretext pass.
  const prepKey = `${fontEpoch}|${state.font}|${state.letterSpacing}`
  if (state.prepKey !== prepKey) {
    state.prep = prepare(state.snapshot, state.font, state.letterSpacing)
    state.prepKey = prepKey
  }
  if (state.prep === null) return

  layout(state.snapshot, state.prep, targetWidth)
}

// snapshot — collect the original text nodes inside a paragraph
//
// We support inline HTML (italics, links, footnote refs, etc.) by walking
// the element's text nodes in document order. Each character of the flat
// text we feed to K-P remembers which text node it came from, so after K-P
// we can redistribute the output characters back to the text nodes that
// contributed them. Inline markup is preserved.
function snapshot(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const out = []
  let node
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (parent && (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")) continue
    out.push({textNode: node, original: node.nodeValue ?? ""})
  }
  return out
}

// prepare — the once-per-font work for a paragraph
//
// 1. Concatenate text-node text into a single string, collapsing runs of
//    whitespace as CSS would, while keeping a parallel array recording
//    which text node each character came from.
//
// 2. Run hypher to insert soft hyphens at every legal hyphenation break
//    per Liang's English patterns. Each inserted soft hyphen inherits its
//    origin from the preceding character.
//
// 3. Replace real hyphens with U+2011 so the browser won't treat them as
//    opportunistic break points. This must happen *after* hypher, which
//    uses real hyphens for tokenization.
//
// 4. Pass the prepared string to pretext, which segments it and measures
//    each segment using canvas.measureText. Pretext caches per-(font,
//    glyph) widths globally, so common words are measured exactly once
//    across the whole document.
function prepare(snap, font, letterSpacing) {
  const flat = []
  const flatOrigin = []
  let prevSpace = false

  for (let i = 0; i < snap.length; i++) {
    const entry = snap[i]
    if (!entry.textNode.isConnected) continue
    const text = entry.original
    for (let j = 0; j < text.length; j++) {
      const c = text[j]
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
        if (!prevSpace) {
          flat.push(" ")
          flatOrigin.push(i)
          prevSpace = true
        }
      } else {
        flat.push(c)
        flatOrigin.push(i)
        prevSpace = false
      }
    }
  }

  // Trim leading/trailing whitespace.
  let start = 0
  while (start < flat.length && flat[start] === " ") start++
  let end = flat.length
  while (end > start && flat[end - 1] === " ") end--
  if (end <= start) return null

  const trimmed = flat.slice(start, end).join("")
  const trimmedOrigin = flatOrigin.slice(start, end)

  // Two-pointer walk against hypher's output to build the new origin map.
  // Inserted soft hyphens inherit the origin of the preceding character.
  const hyphenated = hypher.hyphenateText(trimmed)
  const hyphOrigin = new Array(hyphenated.length)
  let fi = 0
  for (let hi = 0; hi < hyphenated.length; hi++) {
    if (fi < trimmed.length && hyphenated[hi] === trimmed[fi]) {
      hyphOrigin[hi] = trimmedOrigin[fi]
      fi++
    } else {
      hyphOrigin[hi] = trimmedOrigin[Math.max(0, fi - 1)]
    }
  }

  // Replace real hyphens with non-breaking ones. Same character count, so
  // the origin map is unchanged.
  let prepText = ""
  for (let i = 0; i < hyphenated.length; i++) {
    prepText += hyphenated[i] === "-" ? NON_BREAKING_HYPHEN : hyphenated[i]
  }

  const prepared = prepareWithSegments(prepText, font, {letterSpacing})
  const normalSpaceWidth = measureGlyph(" ", font) + letterSpacing
  const hyphenWidth = measureGlyph("-", font) + letterSpacing

  return {prepared, hyphOrigin, normalSpaceWidth, hyphenWidth}
}

// layout — the per-resize work
//
// Run findBreaks (the K-P DP) for the current width. Render the chosen
// breaks as a flat output string and write it back to the original text
// nodes by origin. One nodeValue write per text node; one browser reflow
// at end of frame.
function layout(snap, prep, maxWidth) {
  const breaks = findBreaks(prep.prepared, maxWidth, prep.normalSpaceWidth, prep.hyphenWidth)
  const out = render(prep.prepared, breaks, prep.hyphOrigin, snap.length)
  for (let i = 0; i < snap.length; i++) {
    if (snap[i].textNode.isConnected) snap[i].textNode.nodeValue = out[i]
  }
}

// render — turn segments + chosen breaks into per-text-node strings
//
// Walk the prepared segments. For each:
//
//   * Word segment: emit each character verbatim, attributed to its origin.
//   * Whitespace segment: emit a regular space if K-P chose this position
//     as a break, otherwise emit NBSP.
//   * Soft-hyphen segment: emit a SHY if K-P chose this as a break,
//     otherwise omit entirely (so the browser cannot break here at all).
//
// Each output character is appended to the bucket for its origin text
// node. At the end, each text node's content is the join of its bucket.
function render(prepared, breaks, origin, snapshotLength) {
  const segments = prepared.segments

  // Map each segment to the offset in prepText where it begins.
  const segCharStart = new Int32Array(segments.length + 1)
  let pos = 0
  for (let s = 0; s < segments.length; s++) {
    segCharStart[s] = pos
    pos += segments[s].length
  }

  const breakAt = new Map(breaks.map(b => [b.segIndex, b.kind]))
  const buckets = []
  for (let i = 0; i < snapshotLength; i++) buckets.push([])

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const segStart = segCharStart[i]
    const breakKind = breakAt.get(i + 1)

    if (seg === SOFT_HYPHEN) {
      if (breakKind === "soft-hyphen") {
        buckets[origin[segStart] ?? 0].push(SOFT_HYPHEN)
      }
      // else: omit. The browser cannot break at a soft hyphen that is
      // not in the text.
    } else if (isWhitespace(seg)) {
      const ch = breakKind === "space" ? " " : NBSP
      buckets[origin[segStart] ?? 0].push(ch)
    } else {
      for (let j = 0; j < seg.length; j++) {
        buckets[origin[segStart + j] ?? 0].push(seg[j])
      }
    }
  }

  return buckets.map(b => b.join(""))
}

// findBreaks — Knuth & Plass's dynamic program, in textbook form
//
// Each "break" is a candidate position in the segment list where a line
// could end:
//
//   * A "space" break — after a whitespace segment.
//   * A "soft-hyphen" break — after a soft-hyphen segment.
//
// dp[k] is the minimum total badness of a layout that ends at break[k].
// prev[k] is the predecessor break that achieved dp[k].
//
// We try every (from, to) pair where dp[from] is finite, compute the
// badness of the line from break[from] to break[to], and relax dp[to].
// Lines that are catastrophically too wide are pruned: once the natural
// width exceeds 1.6× the column, no longer line will fit either, so we
// stop extending `from` backwards.
//
// At the end, walk prev backwards from the "end" sentinel to recover the
// chosen path. Slice off the trailing "end"; what remains is the chosen
// mid-paragraph breaks.
function findBreaks(prepared, maxWidth, normalSpaceWidth, hyphenWidth) {
  const segments = prepared.segments
  const widths = prepared.widths
  const n = segments.length
  if (n === 0) return []

  const isShy = new Uint8Array(n)
  const isSpaceArr = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    isShy[i] = segments[i] === SOFT_HYPHEN ? 1 : 0
    isSpaceArr[i] = (!isShy[i] && isWhitespace(segments[i])) ? 1 : 0
  }

  // The break list begins with a sentinel "start" and ends with a sentinel
  // "end". Real candidate breaks live between them.
  const breaks = [{segIndex: 0, kind: "start"}]
  for (let i = 0; i < n - 1; i++) {
    if (isShy[i]) breaks.push({segIndex: i + 1, kind: "soft-hyphen"})
    else if (isSpaceArr[i]) breaks.push({segIndex: i + 1, kind: "space"})
  }
  breaks.push({segIndex: n, kind: "end"})

  // Prefix sums let us compute line stats (word-width sum, space count)
  // in O(1) per (from, to) pair.
  const prefixWordW = new Float64Array(n + 1)
  const prefixSpaces = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) {
    prefixWordW[i + 1] = prefixWordW[i] + (isShy[i] || isSpaceArr[i] ? 0 : widths[i])
    prefixSpaces[i + 1] = prefixSpaces[i] + isSpaceArr[i]
  }

  const dp = new Float64Array(breaks.length).fill(Infinity)
  const prev = new Int32Array(breaks.length).fill(-1)
  dp[0] = 0

  for (let to = 1; to < breaks.length; to++) {
    const isLast = to === breaks.length - 1
    for (let from = to - 1; from >= 0; from--) {
      if (dp[from] === Infinity) continue
      const stats = lineStats(breaks, from, to, prefixWordW, prefixSpaces, isSpaceArr, hyphenWidth, normalSpaceWidth)
      if (stats.naturalW > maxWidth * 1.6 && !isLast) break
      const total = dp[from] + badness(stats, maxWidth, normalSpaceWidth, isLast)
      if (total < dp[to]) {
        dp[to] = total
        prev[to] = from
      }
    }
  }

  const path = []
  let cur = breaks.length - 1
  while (cur > 0) {
    if (prev[cur] === -1) { path.length = 0; break }
    path.push(cur)
    cur = prev[cur]
  }
  path.reverse()
  // Drop the trailing "end" sentinel; return only chosen mid-paragraph
  // breaks.
  return path.slice(0, -1).map(b => breaks[b])
}

function lineStats(breaks, fromBreak, toBreak, prefixWordW, prefixSpaces, isSpaceArr, hyphenWidth, normalSpaceWidth) {
  const from = breaks[fromBreak].segIndex
  const to = breaks[toBreak].segIndex
  const toKind = breaks[toBreak].kind

  let wordW = prefixWordW[to] - prefixWordW[from]
  let sp = prefixSpaces[to] - prefixSpaces[from]

  // The line ends at break `to`. If that position came right after a
  // whitespace segment, that whitespace is consumed by the break (it
  // doesn't appear at the end of the line). Don't count it as a
  // line-internal space.
  if (to > from && isSpaceArr[to - 1]) sp -= 1

  // If we break at a soft hyphen, the rendered line gains a hyphen glyph
  // that wasn't in the segment widths.
  if (toKind === "soft-hyphen") wordW += hyphenWidth

  return {wordW, sp, naturalW: wordW + sp * normalSpaceWidth, toKind}
}

// badness — "how bad is this line?"
//
//   * Natural width over the column? Catastrophic; never pick it.
//   * Last line? Free; we don't justify the last line of a paragraph.
//   * Otherwise: cubic penalty on the deviation of stretched space width
//     from the natural space width. Cubic so very-loose lines are very
//     bad and slightly-loose lines are barely bad.
//   * Bonus quartic penalty above MAX_SPACE_RATIO for catastrophically
//     loose lines.
//   * Small fixed cost for a hyphen break, so K-P prefers a clean space
//     break when both work equally well.
function badness(stats, maxWidth, normalSpaceWidth, isLast) {
  if (stats.naturalW > maxWidth) return HUGE_BADNESS
  if (isLast) return 0
  let p
  if (stats.sp <= 0) {
    const slack = maxWidth - stats.wordW
    p = slack * slack * 10
  } else {
    const justified = (maxWidth - stats.wordW) / stats.sp
    const ratio = (justified - normalSpaceWidth) / normalSpaceWidth
    p = ratio * ratio * ratio * 1000
    if (justified > normalSpaceWidth * MAX_SPACE_RATIO) {
      const excess = justified / normalSpaceWidth - MAX_SPACE_RATIO
      p += excess * excess * 4000
    }
  }
  if (stats.toKind === "soft-hyphen") p += 100
  return p
}

function isWhitespace(s) {
  return s.length > 0 && s.trim().length === 0
}

function fontShorthand(style) {
  return `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
}

function lengthPx(value) {
  if (value === "" || value === "normal") return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function measureGlyph(text, font) {
  measuringContext.font = font
  return measuringContext.measureText(text).width
}

// Auto-justify on load. Importing this module is enough to make every
// <p> on the page well-set.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => justifyAll())
} else {
  justifyAll()
}
