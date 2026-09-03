use image::RgbaImage;

/// Rows of overlap the offset search insists on seeing before it will believe
/// a match. Below this, a scroll long enough to leave almost nothing in common
/// can be "confirmed" by a handful of rows agreeing at random.
const MIN_OVERLAP: u32 = 24;
/// Mean absolute difference (0..255, per channel-averaged pixel) at or under
/// which two row bands count as the same content.
const MATCH_THRESHOLD: f32 = 6.0;
/// A second candidate scoring within this of the best one means the content
/// repeats and the search cannot tell the offsets apart. Kept tight: now that
/// only textured rows are scored, a genuinely wrong offset misaligns real
/// content and scores far higher, so anything this close really is a tie.
const AMBIGUITY_MARGIN: f32 = 0.35;
/// Rows are compared every Nth pixel horizontally during the search: enough
/// signal to rank candidates, a fraction of the work.
const X_STEP: u32 = 4;
/// Mean difference at or under which one row counts as agreeing during the
/// full-resolution re-check.
const VERIFY_ROW_THRESHOLD: f32 = 12.0;
/// Fraction of the overlap's rows that must agree before an offset can be
/// committed at all. Deliberately loose -- it is here to reject a frame that
/// is not a scrolled view of this page, not to choose between candidates,
/// which `refine` does. A page with a video or a spinner in it has a band
/// that will never agree, and must still stitch.
const VERIFY_MIN_AGREEMENT: f32 = 0.5;
/// How close a candidate's full-resolution mean must be to the best one to
/// still count as tied. Tight: at this resolution a wrong offset misaligns
/// real content, so anything this near really is the same alignment.
const REFINE_MARGIN: f32 = 0.5;
/// Rows between the offsets the last-resort sweep tries before it narrows
/// down. Coarse enough to keep the sweep affordable on a path that only runs
/// when everything cheaper has failed.
const SWEEP_STRIDE: u32 = 8;
/// How much of a frame must agree, at full resolution and counting every
/// row, before an offset the caller predicted is taken on trust.
///
/// Not set near 1: the frames either side of a page pinning its furniture
/// differ by that whole band, and measured on a real browser that came to a
/// quarter of the overlap. What makes this safe is not the height of the bar
/// but where the number comes from -- the caller measured how far a wheel
/// click moves this application, from a match the search itself confirmed.
const HINT_MIN_AGREEMENT: f32 = 0.6;
/// The share of a candidate's rows that decide its score, worst ones
/// dropped. Three quarters: enough slack for a sticky bar or a video band,
/// far too little to let a wrong offset through.
const TRIM_NUMERATOR: usize = 3;
const TRIM_DENOMINATOR: usize = 4;
/// How much a row must differ from the one above it to count toward a score.
///
/// What pins down a scroll offset is vertical change: a run of identical rows
/// (flat background, or a solid band) matches at *every* offset, and scoring
/// those buries the few rows that actually carry position information. That
/// wide tie set is what produced duplicated content when the winner came out
/// too large, and skipped content when it came out too small.
const ROW_TEXTURE_MIN: f32 = 3.0;
/// Textured rows a candidate must be judged on before its score means
/// anything. Deliberately low: a sparse page (headings and images on white)
/// offers only the edges of each block, and demanding more would reject it
/// outright rather than match it.
const MIN_TEXTURED_ROWS: u32 = 4;

/// What `push` did with a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Push {
    /// Appended this many new rows.
    Appended(u32),
    /// The frame is where the last one was -- nothing scrolled.
    Duplicate,
    /// Content repeats enough that two offsets scored the same. The smallest
    /// plausible offset was appended rather than guessing at the larger one.
    Ambiguous(u32),
    /// No offset matched: the view jumped somewhere unrelated, or the page
    /// stopped scrolling and changed instead.
    NoMatch,
    /// The canvas has reached the caller's height limit; nothing appended.
    HeightCapped,
}

/// Which pixels of a frame are moving on their own (a carousel, a spinner)
/// and so must not be scored. `true` means "ignore this pixel when matching".
/// Indexed row-major over the frame at full resolution.
pub struct Mask {
    pub width: u32,
    pub height: u32,
    pub ignored: Vec<bool>,
}

impl Mask {
    fn ignores(&self, x: u32, y: u32) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        // Indexed rather than sliced: a mask whose declared size disagrees
        // with its data must fall back to "not ignored", never bring the
        // capture down. The caller builds it from the grabbed frame, but the
        // frame's size is decided by the monitor, not by us.
        self.ignored
            .get((y * self.width + x) as usize)
            .copied()
            .unwrap_or(false)
    }
}

/// How well one candidate offset holds up at full resolution.
struct Fit {
    /// Mean difference across every row of the overlap. Ranks candidates
    /// against each other.
    mean: f32,
    /// Share of rows that agree. Judges whether a candidate the *search*
    /// endorsed is real.
    agreement: f32,
    /// Share of rows *with vertical change* that agree. Judges a candidate
    /// nothing else endorsed, because a blank row agrees at every offset and
    /// a page is mostly blank -- margins, gutters, the space between
    /// paragraphs. Counting those would let a badly wrong offset clear any
    /// threshold worth having, appending a sliver each tick while the page
    /// scrolls away underneath.
    textured_agreement: f32,
}

/// Accumulates scrolled frames into one tall image.
///
/// Every frame after the first is matched against the bottom of the canvas to
/// find how far the content moved, and only the genuinely new rows are
/// appended. The matching is deliberately conservative: repeating content
/// (striped tables, uniform lists) can make several offsets look equally
/// good, and appending the wrong one silently corrupts the result in a way
/// the user only notices later.
pub struct Stitcher {
    canvas: RgbaImage,
    width: u32,
    frame_height: u32,
    max_height: u32,
    /// Rows at the top of the frame that stayed identical between the first
    /// two frames -- a sticky header. Cropped from everything appended after
    /// the first frame, which keeps its copy.
    header_rows: u32,
    previous: Option<RgbaImage>,
    /// How far the last accepted frame moved. The caller scrolls by a fixed
    /// number of wheel clicks each tick, so consecutive offsets are nearly
    /// identical -- which makes the previous one a strong prior for picking
    /// between candidates that score the same.
    last_offset: Option<u32>,
    /// Per-row texture flags for the frame currently being matched. Computed
    /// once per `push` rather than per candidate offset.
    textured: Vec<bool>,
    /// How far the caller believes this frame moved, from the scrolling it
    /// asked for. Independent evidence, and on a sparse page it is better
    /// evidence than a handful of rows sampled from a mostly-blank overlap.
    hint: Option<u32>,
}

impl Stitcher {
    pub fn new(first: RgbaImage, max_height: u32) -> Self {
        let width = first.width();
        let frame_height = first.height();
        Self {
            canvas: first.clone(),
            width,
            frame_height,
            max_height,
            header_rows: 0,
            previous: Some(first),
            last_offset: None,
            textured: Vec::new(),
            hint: None,
        }
    }

    /// The most recent frame pushed, which the caller waits to see change
    /// before it trusts that a scroll has landed.
    pub fn last_frame(&self) -> &RgbaImage {
        self.previous.as_ref().unwrap_or(&self.canvas)
    }

    /// Tells the stitcher how far the next frame is expected to have moved.
    /// Set from the scroll the caller actually performed; cleared when it has
    /// no idea.
    pub fn expect(&mut self, offset: Option<u32>) {
        self.hint = offset;
    }

    /// One frame's height -- what the caller sizes its scroll step against.
    pub fn frame_height(&self) -> u32 {
        self.frame_height
    }

    pub fn height(&self) -> u32 {
        self.canvas.height()
    }

    pub fn finish(self) -> RgbaImage {
        self.canvas
    }

    /// Mean absolute difference between canvas row `cy` and frame row `fy`,
    /// skipping masked pixels. `None` when the mask left nothing to compare.
    fn row_diff(&self, frame: &RgbaImage, cy: u32, fy: u32, mask: Option<&Mask>) -> Option<f32> {
        let mut total = 0u32;
        let mut counted = 0u32;
        let mut x = 0;
        while x < self.width {
            if mask.is_none_or(|m| !m.ignores(x, fy)) {
                let c = self.canvas.get_pixel(x, cy).0;
                let f = frame.get_pixel(x, fy).0;
                total += c[0].abs_diff(f[0]) as u32
                    + c[1].abs_diff(f[1]) as u32
                    + c[2].abs_diff(f[2]) as u32;
                counted += 3;
            }
            x += X_STEP;
        }
        (counted > 0).then(|| total as f32 / counted as f32)
    }

    /// Whether a row differs enough from the one above it to be worth
    /// matching on.
    fn row_is_textured(frame: &RgbaImage, y: u32) -> bool {
        if y == 0 {
            return false;
        }
        let mut total = 0u32;
        let mut counted = 0u32;
        let mut x = 0;
        while x < frame.width() {
            let a = frame.get_pixel(x, y - 1).0;
            let b = frame.get_pixel(x, y).0;
            total += a[0].abs_diff(b[0]) as u32
                + a[1].abs_diff(b[1]) as u32
                + a[2].abs_diff(b[2]) as u32;
            counted += 3;
            x += X_STEP;
        }
        counted > 0 && total as f32 / counted as f32 >= ROW_TEXTURE_MIN
    }

    /// Scores one candidate offset: how well the frame's top `overlap` rows
    /// (below any sticky header) line up with the canvas's bottom rows once
    /// the content has moved up by `offset`.
    ///
    /// A trimmed mean rather than a plain one, so a band that never matches
    /// costs its own rows and no more. Pages grow sticky furniture *after*
    /// the capture starts -- a repository's file-nav bar that pins itself
    /// once you scroll past the file list, a toolbar that slides in, a cookie
    /// banner -- and `detect_header` only ever sees the first two frames. Let
    /// the worst rows decide and one such band makes every offset look wrong,
    /// which ends the capture a screenful in.
    fn score(&self, frame: &RgbaImage, offset: u32, mask: Option<&Mask>) -> Option<f32> {
        let overlap = self.frame_height.checked_sub(offset)?;
        if overlap < MIN_OVERLAP {
            return None;
        }
        let canvas_top = self.canvas.height().checked_sub(overlap)?;
        let start = self.header_rows.min(overlap.saturating_sub(1));

        let mut diffs: Vec<f32> = Vec::new();
        for y in start..overlap {
            // Flat rows agree at any offset, so they are skipped rather than
            // averaged in.
            // Unknown rows score rather than being skipped: the cache is
            // filled by `push`, and a missing entry must not silently drop a
            // row from the comparison.
            if self.textured.get(y as usize).copied().unwrap_or(true) {
                if let Some(d) = self.row_diff(frame, canvas_top + y, y, mask) {
                    diffs.push(d);
                }
            }
        }
        if diffs.len() < MIN_TEXTURED_ROWS as usize {
            return None;
        }
        diffs.sort_by(f32::total_cmp);
        // Trimmed equally for every candidate, so the ranking between them is
        // untouched -- a wrong offset misaligns nearly every row, and its best
        // three quarters are bad too.
        let keep = (diffs.len() * TRIM_NUMERATOR / TRIM_DENOMINATOR)
            .max(MIN_TEXTURED_ROWS as usize)
            .min(diffs.len());
        Some(diffs[..keep].iter().sum::<f32>() / keep as f32)
    }

    /// Rows at the top of the frame that did not move between two frames --
    /// a sticky header, which must be cropped from everything appended after
    /// the first frame.
    ///
    /// The identical prefix is trimmed back to the last row carrying any
    /// vertical change: a page whose content begins below a blank margin has
    /// an identical prefix that is no header at all, and cropping it would
    /// eat real content.
    fn detect_header(&self, a: &RgbaImage, b: &RgbaImage) -> u32 {
        let mut rows = 0;
        while rows < self.frame_height {
            let mut same = true;
            let mut x = 0;
            while x < self.width {
                if a.get_pixel(x, rows) != b.get_pixel(x, rows) {
                    same = false;
                    break;
                }
                x += X_STEP;
            }
            if !same {
                break;
            }
            rows += 1;
        }
        while rows > 0 && !Self::row_is_textured(b, rows - 1) {
            rows -= 1;
        }
        rows
    }

    /// Re-measures a candidate offset at full horizontal resolution and over
    /// *every* row of the overlap, not just the textured ones. Returns the
    /// mean difference and the fraction of rows that agree, or `None` if the
    /// mask left nothing to compare.
    ///
    /// The search skips flat rows on purpose -- they carry no position
    /// information of their own. But that also throws away what separates two
    /// candidates a few pixels apart: a solid block is identical row to row,
    /// so a shift *within* one scores a perfect zero on the block's edges,
    /// while the blank row above it lands on the block's colour and would
    /// have given the answer away. So the ranking pass looks at everything.
    fn refine(&self, frame: &RgbaImage, offset: u32, mask: Option<&Mask>) -> Option<Fit> {
        let overlap = self.frame_height.checked_sub(offset)?;
        let canvas_top = self.canvas.height().checked_sub(overlap)?;
        let start = self.header_rows.min(overlap.saturating_sub(1));
        let mut sum = 0.0f64;
        let mut agreed = 0u32;
        let mut agreed_all = 0u32;
        let mut rows = 0u32;
        let mut textured_rows = 0u32;
        for y in start..overlap {
            let mut total = 0u64;
            let mut counted = 0u64;
            for x in 0..self.width {
                if mask.is_some_and(|m| m.ignores(x, y)) {
                    continue;
                }
                let c = self.canvas.get_pixel(x, canvas_top + y).0;
                let f = frame.get_pixel(x, y).0;
                total += (c[0].abs_diff(f[0]) as u32
                    + c[1].abs_diff(f[1]) as u32
                    + c[2].abs_diff(f[2]) as u32) as u64;
                counted += 3;
            }
            if counted == 0 {
                continue;
            }
            let mean = total as f32 / counted as f32;
            rows += 1;
            sum += mean as f64;
            let agrees = mean <= VERIFY_ROW_THRESHOLD;
            if agrees {
                agreed_all += 1;
            }
            if self.textured.get(y as usize).copied().unwrap_or(true) {
                textured_rows += 1;
                if agrees {
                    agreed += 1;
                }
            }
        }
        if rows == 0 {
            return None;
        }
        Some(Fit {
            mean: (sum / rows as f64) as f32,
            agreement: agreed_all as f32 / rows as f32,
            // An overlap with no textured rows has nothing to judge by, so it
            // falls back to the all-rows figure rather than claiming
            // certainty either way.
            textured_agreement: if textured_rows > 0 {
                agreed as f32 / textured_rows as f32
            } else {
                agreed_all as f32 / rows as f32
            },
        })
    }

    /// Matches `frame` against the canvas and appends whatever is new.
    pub fn push(&mut self, frame: RgbaImage, mask: Option<&Mask>) -> Push {
        if frame.width() != self.width || frame.height() != self.frame_height {
            return Push::NoMatch;
        }
        if self.canvas.height() >= self.max_height {
            return Push::HeightCapped;
        }

        self.textured = (0..self.frame_height)
            .map(|y| Self::row_is_textured(&frame, y))
            .collect();

        // Learn the sticky header before scoring, not after: the very first
        // scrolled frame is already carrying it, and scoring rows that never
        // move against rows that did is what makes a good match look bad.
        //
        // Re-checked every frame rather than only once, and only ever grown:
        // pages pin their furniture *late*. A repository's file-nav bar, a
        // toolbar that slides in, a banner that sticks after the first
        // screenful -- none of them are in the first two frames, and a header
        // learned once misses them for the rest of the capture.
        if let Some(prev) = &self.previous {
            let found = self.detect_header(prev, &frame).min(self.frame_height / 3);
            self.header_rows = self.header_rows.max(found);
        }

        // Offset 0 means the view has not moved. Checked first and on its own
        // so an unscrolled frame is never mistaken for a tiny scroll.
        if self
            .score(&frame, 0, mask)
            .is_some_and(|s| s <= MATCH_THRESHOLD)
        {
            self.previous = Some(frame);
            return Push::Duplicate;
        }

        // Collect every candidate that matches, rather than keeping only the
        // best: on a page with repeating structure (a sidebar of near-identical
        // cards) several offsets score the same, and which one is *right* is
        // decided below by how far the last frame moved, not by the score.
        let mut matches: Vec<(u32, f32)> = Vec::new();
        for offset in 1..=self.frame_height.saturating_sub(MIN_OVERLAP) {
            if let Some(s) = self.score(&frame, offset, mask) {
                if s <= MATCH_THRESHOLD {
                    matches.push((offset, s));
                }
            }
        }
        if matches.is_empty() {
            return self.sweep(frame, mask);
        }

        let best_score = matches.iter().map(|(_, s)| *s).fold(f32::MAX, f32::min);
        // Everything scoring within the margin of the best is, as far as the
        // pixels go, equally plausible.
        let tied: Vec<u32> = matches
            .iter()
            .filter(|(_, s)| *s - best_score < AMBIGUITY_MARGIN)
            .map(|(o, _)| *o)
            .collect();
        let ambiguous = tied.len() > 1;

        // Rank the tied candidates by what the sampled search could not see,
        // and keep only those that hold up at all. Ranking rather than an
        // absolute cut-off: on a page with something animating in it, *every*
        // candidate carries that band's disagreement, and the right offset is
        // still the one that carries the least.
        let mut ranked: Vec<(u32, f32)> = tied
            .iter()
            .filter_map(|o| {
                let fit = self.refine(&frame, *o, mask)?;
                (fit.agreement >= VERIFY_MIN_AGREEMENT).then_some((*o, fit.mean))
            })
            .collect();
        if ranked.is_empty() {
            // Nothing survives a proper look: the view jumped somewhere else,
            // or the page swapped its content out from under us. Appending on
            // the strength of the sampled search alone would silently
            // duplicate or drop a band, and the user would only find out by
            // reading the finished screenshot.
            return self.sweep(frame, mask);
        }
        let best_refined = ranked.iter().map(|(_, m)| *m).fold(f32::MAX, f32::min);
        ranked.retain(|(_, m)| *m <= best_refined + REFINE_MARGIN);

        // The caller's own account of how far it scrolled beats any prior
        // drawn from the pixels, so it picks between survivors first.
        let offset = match self.hint.or(self.last_offset) {
            // Still tied after all that, so the content really does repeat.
            // The step is the same every tick until the page bottom clamps
            // it -- and clamping only ever makes it *smaller*. Take the
            // expected step if it is on offer, else the largest candidate
            // below it, and only fall back to the nearest one above when
            // nothing below survived.
            Some(last) => ranked
                .iter()
                .map(|(o, _)| *o)
                .filter(|o| *o <= last)
                .max()
                .unwrap_or_else(|| {
                    ranked
                        .iter()
                        .map(|(o, _)| *o)
                        .min_by_key(|o| o.abs_diff(last))
                        .expect("ranked is non-empty")
                }),
            // No prior yet: the smallest offset can only duplicate content,
            // never skip any, which is the safe direction to be wrong in.
            None => ranked.iter().map(|(o, _)| *o).min().expect("ranked is non-empty"),
        };

        let appended = self.append(&frame, offset);
        self.last_offset = Some(offset);
        self.previous = Some(frame);
        if ambiguous {
            Push::Ambiguous(appended)
        } else {
            Push::Appended(appended)
        }
    }

    /// Last resort when the search has found nothing it can stand behind:
    /// falls back on how far the caller actually scrolled.
    ///
    /// Tried in that order, and only here, because the search is right far
    /// more often than not -- and at the bottom of a page, where the last
    /// scroll is clamped to whatever distance was left, the expected offset
    /// is too *large*. Preferring it there appends a band twice. So the
    /// expectation is the fallback: first as itself, then as a ceiling on a
    /// walk downwards, since a scroll can come up short of what was asked
    /// but never overshoot it.
    fn sweep(&mut self, frame: RgbaImage, mask: Option<&Mask>) -> Push {
        let Some(hint) = self.hint.filter(|h| *h > 1 && *h < self.frame_height) else {
            return Push::NoMatch;
        };
        // The expected distance first: it is the single most likely answer,
        // and it is what carries a page that pins furniture mid-capture,
        // where the band that stops moving makes the *right* offset score
        // worse than a wrong one and the search cannot rank them.
        if self
            .refine(&frame, hint, mask)
            .is_some_and(|f| f.textured_agreement >= HINT_MIN_AGREEMENT)
        {
            let appended = self.append(&frame, hint);
            self.last_offset = Some(hint);
            self.previous = Some(frame);
            return Push::Appended(appended);
        }
        let mut best: Option<(u32, f32)> = None;
        let mut offset = SWEEP_STRIDE;
        while offset < hint {
            if let Some(fit) = self.refine(&frame, offset, mask) {
                let a = fit.textured_agreement;
                if a >= HINT_MIN_AGREEMENT && best.is_none_or(|(_, b)| a > b) {
                    best = Some((offset, a));
                }
            }
            offset += SWEEP_STRIDE;
        }
        let Some((coarse, _)) = best else {
            return Push::NoMatch;
        };
        // Then the exact row, within one stride of the coarse winner.
        let lo = coarse.saturating_sub(SWEEP_STRIDE - 1).max(1);
        let hi = (coarse + SWEEP_STRIDE - 1).min(hint);
        let mut exact = (coarse, 0.0f32);
        for o in lo..=hi {
            if let Some(fit) = self.refine(&frame, o, mask) {
                if fit.textured_agreement > exact.1 {
                    exact = (o, fit.textured_agreement);
                }
            }
        }
        let appended = self.append(&frame, exact.0);
        self.last_offset = Some(exact.0);
        self.previous = Some(frame);
        Push::Appended(appended)
    }

    /// Copies the rows `offset` revealed onto the bottom of the canvas,
    /// skipping the sticky header band.
    fn append(&mut self, frame: &RgbaImage, offset: u32) -> u32 {
        let from = self.frame_height - offset;
        let start = from.max(self.header_rows);
        if start >= self.frame_height {
            return 0;
        }
        let new_rows = (self.frame_height - start).min(self.max_height - self.canvas.height());
        if new_rows == 0 {
            return 0;
        }
        let mut grown = RgbaImage::new(self.width, self.canvas.height() + new_rows);
        image::imageops::replace(&mut grown, &self.canvas, 0, 0);
        for y in 0..new_rows {
            for x in 0..self.width {
                grown.put_pixel(
                    x,
                    self.canvas.height() + y,
                    *frame.get_pixel(x, start + y),
                );
            }
        }
        self.canvas = grown;
        new_rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// A tall "page" of deterministic pseudo-random rows -- unique enough per
    /// row that an offset search has real signal to find.
    fn page(width: u32, height: u32) -> RgbaImage {
        let mut img = RgbaImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                // Hashed with an avalanche step rather than mixed linearly:
                // the earlier version was linear in `y`, so rows a fixed
                // distance apart differed by a constant handful of levels --
                // a page that quietly repeats every 40 rows. No fixture
                // should hand the matcher content like that; the tests that
                // *want* repetition build it deliberately, in `striped`.
                let mut h = y.wrapping_mul(0x9E37_79B1) ^ x.wrapping_mul(0x85EB_CA77);
                h ^= h >> 15;
                h = h.wrapping_mul(0x2545_F491);
                h ^= h >> 13;
                img.put_pixel(x, y, Rgba([h as u8, (h >> 8) as u8, (h >> 16) as u8, 255]));
            }
        }
        img
    }

    /// A page in the shape real content actually takes: a white field with a
    /// bar of varying width and colour every `row` pixels, and nothing
    /// between them. Only the bars' top and bottom edges carry any vertical
    /// change, so almost every row of it is untextured -- the sparsest input
    /// the offset search has to cope with.
    fn barred(width: u32, height: u32, row: u32) -> RgbaImage {
        let mut img = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
        let palette = [
            [192, 57, 43],
            [41, 128, 185],
            [39, 174, 96],
            [142, 68, 173],
            [211, 84, 0],
            [22, 160, 133],
        ];
        for i in 0..height / row {
            let seed = i.wrapping_mul(2654435761) >> 7;
            let w = 80 + seed % (width - 160);
            let c = palette[(seed >> 11) as usize % palette.len()];
            for y in i * row + 10..(i * row + 30).min(height) {
                for x in 30..(30 + w).min(width) {
                    img.put_pixel(x, y, Rgba([c[0], c[1], c[2], 255]));
                }
            }
        }
        img
    }

    /// A page whose rows repeat every `period` -- stripes, the case that
    /// makes several offsets score identically.
    fn striped(width: u32, height: u32, period: u32) -> RgbaImage {
        let mut img = RgbaImage::new(width, height);
        for y in 0..height {
            let band = (y % period) as u8;
            for x in 0..width {
                let v = band.wrapping_mul(37).wrapping_add((x % 3) as u8);
                img.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        img
    }

    fn viewport(page: &RgbaImage, top: u32, height: u32) -> RgbaImage {
        image::imageops::crop_imm(page, 0, top, page.width(), height).to_image()
    }

    #[test]
    fn recovers_an_exact_scroll_offset() {
        let src = page(64, 600);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        assert_eq!(s.push(viewport(&src, 60, 200), None), Push::Appended(60));
        assert_eq!(s.height(), 260);
    }

    #[test]
    fn follows_irregular_scroll_steps() {
        let src = page(64, 900);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        let mut top = 0;
        for step in [40, 91, 17, 120, 63] {
            top += step;
            let got = s.push(viewport(&src, top, 200), None);
            assert!(matches!(got, Push::Appended(n) if n == step), "step {step} gave {got:?}");
        }
        // Canvas is the first viewport plus every step, which is exactly the
        // page region scrolled through.
        assert_eq!(s.height(), 200 + 40 + 91 + 17 + 120 + 63);
    }

    #[test]
    fn stitched_output_matches_the_source_page() {
        let src = page(48, 500);
        let mut s = Stitcher::new(viewport(&src, 0, 150), 10_000);
        for top in [70, 140, 210] {
            s.push(viewport(&src, top, 150), None);
        }
        let out = s.finish();
        assert_eq!(out.height(), 360);
        for y in 0..out.height() {
            for x in 0..out.width() {
                assert_eq!(out.get_pixel(x, y), src.get_pixel(x, y), "row {y} col {x}");
            }
        }
    }

    #[test]
    fn an_unscrolled_frame_is_a_duplicate() {
        let src = page(64, 400);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        assert_eq!(s.push(viewport(&src, 0, 200), None), Push::Duplicate);
        assert_eq!(s.height(), 200);
    }

    #[test]
    fn unrelated_content_does_not_match() {
        let a = page(64, 400);
        let b = striped(64, 400, 7);
        let mut s = Stitcher::new(viewport(&a, 0, 200), 10_000);
        assert_eq!(s.push(viewport(&b, 0, 200), None), Push::NoMatch);
    }

    #[test]
    fn repeating_content_scrolled_by_a_whole_period_reads_as_unmoved() {
        // Scrolled by exactly one stripe period the view is pixel-identical
        // to where it was; there is no evidence it moved at all, and saying
        // "duplicate" is the honest answer.
        let src = striped(64, 600, 10);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        assert_eq!(s.push(viewport(&src, 30, 200), None), Push::Duplicate);
    }

    #[test]
    fn repeating_content_is_reported_as_ambiguous() {
        // Offsets 3, 13, 23... all score identically on a 10-row stripe, so
        // the search must flag that it cannot tell them apart.
        let src = striped(64, 600, 10);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        assert!(matches!(s.push(viewport(&src, 33, 200), None), Push::Ambiguous(_)));
    }

    #[test]
    fn ambiguity_falls_back_to_the_smallest_plausible_offset() {
        // Appending the smallest match can only duplicate content, never
        // skip any -- the safe direction to be wrong in.
        let src = striped(64, 600, 10);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        let Push::Ambiguous(rows) = s.push(viewport(&src, 33, 200), None) else {
            panic!("expected an ambiguous match");
        };
        assert!(rows <= 13, "appended {rows} rows, expected the smallest match");
    }

    #[test]
    fn a_sticky_header_is_not_appended_twice() {
        let src = page(64, 600);
        // Paint a fixed 20-row header that every viewport will show.
        let header = page(64, 20);
        let mut s = {
            let mut first = viewport(&src, 0, 200);
            image::imageops::replace(&mut first, &header, 0, 0);
            Stitcher::new(first, 10_000)
        };
        for top in [50u32, 100, 150] {
            let mut frame = viewport(&src, top, 200);
            image::imageops::replace(&mut frame, &header, 0, 0);
            s.push(frame, None);
        }
        // Without header handling each tick would re-append the 20 header
        // rows, inflating the canvas well past the scrolled distance.
        assert_eq!(s.height(), 200 + 50 + 50 + 50);
    }

    #[test]
    fn a_masked_region_does_not_break_the_match() {
        let src = page(64, 600);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        // Corrupt a band the way an autoplaying carousel would, then mask it.
        let mut frame = viewport(&src, 60, 200);
        for y in 40..90 {
            for x in 0..64 {
                frame.put_pixel(x, y, Rgba([255, 0, 255, 255]));
            }
        }
        let mut ignored = vec![false; (64 * 200) as usize];
        for y in 40..90u32 {
            for x in 0..64u32 {
                ignored[(y * 64 + x) as usize] = true;
            }
        }
        let mask = Mask { width: 64, height: 200, ignored };
        assert_eq!(s.push(frame, Some(&mask)), Push::Appended(60));
    }

    #[test]
    fn a_flat_animating_region_survives_without_a_mask() {
        // A solid band (a video letterbox, a loading placeholder) has no
        // vertical change, so it is skipped as untextured and the match still
        // lands. The mask is a refinement here, not a requirement.
        let src = page(64, 600);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        let mut frame = viewport(&src, 60, 200);
        for y in 40..90 {
            for x in 0..64 {
                frame.put_pixel(x, y, Rgba([255, 0, 255, 255]));
            }
        }
        assert_eq!(s.push(frame, None), Push::Appended(60));
    }

    #[test]
    fn a_noisy_animating_region_needs_its_mask() {
        // Content that changes *and* is textured -- a playing video -- does
        // corrupt the score, and masking it is what rescues the match. This
        // is the case the mask earns its keep on.
        let src = page(64, 600);
        let noise = page(64, 600);
        let mut corrupt = viewport(&src, 60, 200);
        for y in 60..110u32 {
            for x in 0..64u32 {
                // Unrelated texture, not a flat fill.
                corrupt.put_pixel(x, y, *noise.get_pixel(x, (y * 7 + 13) % 600));
            }
        }

        let mut without = Stitcher::new(viewport(&src, 0, 200), 10_000);
        assert_ne!(without.push(corrupt.clone(), None), Push::Appended(60));

        let mut ignored = vec![false; (64 * 200) as usize];
        for y in 60..110u32 {
            for x in 0..64u32 {
                ignored[(y * 64 + x) as usize] = true;
            }
        }
        let mask = Mask { width: 64, height: 200, ignored };
        let mut with = Stitcher::new(viewport(&src, 0, 200), 10_000);
        assert_eq!(with.push(corrupt, Some(&mask)), Push::Appended(60));
    }

    /// The bug this prior exists for: a page with a repeating column (a
    /// sidebar of near-identical cards) offers several equally-good offsets,
    /// and picking the smallest re-appends content that is already on the
    /// canvas -- duplicated blocks in the finished screenshot.
    #[test]
    fn a_repeating_column_does_not_duplicate_content() {
        let width = 96;
        let mut src = page(width, 1200);
        // Right half repeats every 50 rows, the way a list of uniform cards
        // does; left half stays unique, as body copy does.
        for y in 0..1200u32 {
            for x in 48..width {
                let v = ((y % 50) * 5) as u8;
                src.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        let mut s = Stitcher::new(viewport(&src, 0, 300), 10_000);
        let mut top = 0;
        for _ in 0..6 {
            top += 100;
            match s.push(viewport(&src, top, 300), None) {
                Push::Appended(n) | Push::Ambiguous(n) => {
                    assert_eq!(n, 100, "appended {n} rows for a 100-row scroll")
                }
                other => panic!("expected a match, got {other:?}"),
            }
        }
        assert_eq!(s.height(), 300 + 600);
        // And the result is the page itself, with nothing repeated.
        let out = s.finish();
        for y in 0..out.height() {
            assert_eq!(out.get_pixel(0, y), src.get_pixel(0, y), "row {y}");
        }
    }

    /// A web page: mostly flat background, with occasional bands of content.
    /// Scoring the flat rows made many offsets tie, and whichever way the tie
    /// broke the result was wrong -- too large duplicated a block, too small
    /// cut one out. Only the rows that change vertically are scored now, so
    /// the true offset wins outright.
    #[test]
    fn a_mostly_blank_page_still_lands_on_the_exact_offset() {
        let width = 120;
        let height = 1500;
        let mut src = RgbaImage::from_pixel(width, height, Rgba([250, 250, 250, 255]));
        // Content every 70 rows, 12 rows tall, at varying x -- roughly the
        // density of text blocks on a page.
        for i in 0..(height / 70) {
            let y0 = i * 70 + 10;
            let x0 = 10 + (i * 17) % 60;
            let w = 30 + (i * 13) % 50;
            let shade = (40 + (i * 29) % 180) as u8;
            for y in y0..(y0 + 12).min(height) {
                for x in x0..(x0 + w).min(width) {
                    // Varied per row as well as per block: a vertically
                    // uniform block would match at any shift inside its own
                    // height, which real text never does.
                    let r = shade.wrapping_add((y * 11) as u8);
                    src.put_pixel(x, y, Rgba([r, shade / 2, 200 - shade / 2, 255]));
                }
            }
        }

        let mut s = Stitcher::new(viewport(&src, 0, 400), 10_000);
        let mut top = 0;
        for step in [180, 175, 182, 178] {
            top += step;
            // Either verdict is fine; what matters is that the offset is
            // exact. Sparse content leaves other candidates scoring close,
            // so `Ambiguous` here means "close call, still right".
            match s.push(viewport(&src, top, 400), None) {
                Push::Appended(n) | Push::Ambiguous(n) => {
                    assert_eq!(n, step, "expected a {step}-row scroll")
                }
                other => panic!("expected a match, got {other:?}"),
            }
        }
        let out = s.finish();
        for y in 0..out.height() {
            assert_eq!(out.get_pixel(20, y), src.get_pixel(20, y), "row {y}");
        }
    }

    /// Verification is the last gate before anything reaches the canvas. A
    /// frame that is not a scrolled view of the page at all -- the window
    /// changed underneath us -- must be refused even if some offset happens
    /// to score well on the sampled search.
    /// The last tick of a page moves only as far as the bottom, not a full
    /// wheel step. Snapping that short offset back up to the previous step
    /// re-appends the difference, which reads as a widened gap in the result.
    #[test]
    fn the_last_short_scroll_of_a_page_is_not_rounded_up() {
        let src = page(64, 500);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        // Three full steps of 60, then the page runs out with 25 left.
        for i in 1..=3u32 {
            assert_eq!(s.push(viewport(&src, i * 60, 200), None), Push::Appended(60));
        }
        assert_eq!(s.push(viewport(&src, 205, 200), None), Push::Appended(25));
        assert_eq!(s.height(), 405, "the canvas must be exactly the page walked");
        // And the result is the page itself, not the page with a band repeated.
        let want = viewport(&src, 0, 405);
        assert_eq!(s.finish(), want);
    }

    /// The shape of the real bug, with the real numbers: a sparse page where
    /// only bar edges are textured, walked at a constant 210 until the bottom
    /// clamps the last step to 170. The clamped step must land exactly, or
    /// the seam gains a band of duplicated whitespace.
    #[test]
    fn a_sparse_page_walked_to_its_end_lands_exactly() {
        let src = barred(810, 12_000, 40);
        let mut s = Stitcher::new(viewport(&src, 40, 640), 20_000);
        let mut top = 40u32;
        for _ in 0..53 {
            top += 210;
            let got = s.push(viewport(&src, top, 640), None);
            assert!(
                matches!(got, Push::Appended(210) | Push::Ambiguous(210)),
                "step to {top} gave {got:?}, wanted 210"
            );
        }
        assert_eq!(top, 11_170);
        // The view can go no further than 11_340, so the last step is 170.
        let got = s.push(viewport(&src, 11_340, 640), None);
        assert!(
            matches!(got, Push::Appended(170) | Push::Ambiguous(170)),
            "the clamped last step gave {got:?}, wanted 170"
        );
        assert_eq!(s.finish(), viewport(&src, 40, 11_940));
    }

    /// A mask can arrive describing a larger area than its data covers -- the
    /// grab is clamped to the monitor while the region is not. That used to
    /// index past the end and panic, killing the capture thread mid-scroll
    /// with no error anywhere the user could see.
    #[test]
    fn a_mask_shorter_than_its_dimensions_does_not_panic() {
        let src = page(64, 400);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        let mask = Mask { width: 64, height: 200, ignored: vec![false; 10] };
        assert_eq!(s.push(viewport(&src, 60, 200), Some(&mask)), Push::Appended(60));
    }

    /// The bug a real page hit: a sticky bar that pins itself only *after*
    /// the capture has started, so `detect_header` -- which sees the first
    /// two frames and no more -- never learns about it. Every frame from then
    /// on carries a band that does not move, and the capture must keep going
    /// rather than reading that as the page having ended.
    #[test]
    fn a_sticky_bar_that_appears_mid_capture_does_not_end_it() {
        let src = page(200, 2_000);
        let bar = |img: &mut RgbaImage| {
            for y in 60..110u32 {
                for x in 0..200u32 {
                    img.put_pixel(x, y, Rgba([20, 90, 200, 255]));
                }
            }
        };
        let mut s = Stitcher::new(viewport(&src, 0, 400), 10_000);
        // Two clean frames, so the header detection sees no sticky furniture.
        assert!(matches!(s.push(viewport(&src, 100, 400), None), Push::Appended(100)));
        // From here the bar is pinned over the same rows of every frame.
        for i in 2..=8u32 {
            let mut frame = viewport(&src, i * 100, 400);
            bar(&mut frame);
            let got = s.push(frame, None);
            assert!(
                matches!(got, Push::Appended(100) | Push::Ambiguous(100)),
                "frame {i} gave {got:?}, wanted a 100px advance"
            );
        }
        assert_eq!(s.height(), 400 + 8 * 100);
    }

    #[test]
    fn a_frame_from_a_different_page_is_refused() {
        let src = page(64, 600);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        // Same statistics, different content: the sampled search may find a
        // flattering offset, the full-resolution check will not.
        let other = {
            let mut img = page(64, 600);
            for y in 0..600u32 {
                for x in 0..64u32 {
                    let p = img.get_pixel(x, y).0;
                    img.put_pixel(x, y, Rgba([p[2], p[0], p[1], 255]));
                }
            }
            img
        };
        assert_eq!(s.push(viewport(&other, 60, 200), None), Push::NoMatch);
        assert_eq!(s.height(), 200, "nothing may be appended on a refused frame");
    }

    #[test]
    fn the_height_cap_stops_the_capture() {
        let src = page(64, 900);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 260);
        assert_eq!(s.push(viewport(&src, 60, 200), None), Push::Appended(60));
        assert_eq!(s.push(viewport(&src, 120, 200), None), Push::HeightCapped);
        assert_eq!(s.height(), 260);
    }

    #[test]
    fn a_differently_sized_frame_is_rejected() {
        let src = page(64, 400);
        let mut s = Stitcher::new(viewport(&src, 0, 200), 10_000);
        assert_eq!(s.push(page(48, 200), None), Push::NoMatch);
    }
}
