// F056: Custom Transcription Dictionary.
//
// A user-editable list of terms that speech-to-text keeps getting wrong
// ("n8n" heard as "n eight n", "Tandem" as "tandum"). It is applied in two
// independent places, because neither alone is sufficient:
//
//   1. DECODER BIAS. The term list is added to the Whisper `initial_prompt`
//      so the decoder is nudged toward the right spelling in the first place.
//      This only works for providers that expose a prompt/keyterm field, and it
//      is a hint, never a guarantee.
//   2. POST-CORRECTION. After ANY provider returns text, `apply_corrections`
//      rewrites each alias to its term with a case-insensitive, whole-word
//      match. This is deterministic and provider-agnostic, so it also covers
//      the cloud providers that have no prompt field at all.
//
// The transcription hot path must never hit SQLite, so the compiled form lives
// in `cache` behind an Arc snapshot that the Tauri commands refresh after each
// mutation.

pub mod cache;
pub mod commands;

use regex::{Regex, RegexBuilder};
use std::collections::HashMap;

/// A dictionary compiled into a single matcher.
///
/// The whole dictionary is ONE regex alternation rather than a regex per alias
/// applied in sequence. Sequential per-alias passes are not composable: an
/// earlier pass rewrites text that a later pass then matches again. With the
/// entry (term "Claude Code", alias "Claude"), sequential passes turn
/// "ask Claude Code about it" into "ask Claude Code Code about it", because the
/// alias "Claude" fires on the first word of a term that is already correct.
/// A single left-to-right pass cannot do that: every character of the input is
/// consumed by at most one match, and matched text is never rescanned.
///
/// WHAT THAT DOES AND DOES NOT GUARANTEE. Within one pass, no substitution can
/// feed another, so already-correct text always survives and the pathologies
/// above are gone. It is NOT a guarantee that re-running the pass is a no-op in
/// every conceivable dictionary, because a replacement can end up adjacent to
/// untouched text on its LEFT and the pair can form an alias that the first pass
/// never saw. With ("why zed", alias "ex") and ("W", alias "double why"),
/// "double ex here" corrects to "double why zed here", and a hypothetical second
/// pass would then see the newly adjacent "double why" and produce "W zed here".
///
/// This is safe in practice because every live path applies EXACTLY ONE pass:
/// the batch worker, the realtime partial and commit bridges, and the canvas
/// clip command each call `apply_corrections` once on provider output. The one
/// place that compares corrected text against corrected text, the worker's
/// overlap dedupe, compares two strings that each had one pass applied, never a
/// once-corrected string against a twice-corrected one.
///
/// A second pass is guaranteed stable only when no term's first word can combine
/// with a preceding word to form another entry's alias. That holds for every
/// ordinary dictionary, which is why `every_correction_is_a_fixed_point_across_a_mixed_dictionary`
/// passes, and `a_second_pass_is_not_guaranteed_stable_for_left_joining_aliases`
/// pins the contrived shape where it does not.
#[derive(Debug, Default)]
pub struct CompiledDictionary {
    /// Terms in the order the user created them. This is the order they reach
    /// the decoder prompt in, so it must stay stable and must NOT be sorted by
    /// length (see `prompt_terms`).
    terms: Vec<String>,
    /// The alternation over every alias AND every term. `None` when the
    /// dictionary has nothing to match, so the hot path can skip all work.
    matcher: Option<Regex>,
    /// Lowercased pattern text to its replacement. `None` means "this pattern is
    /// a term, emit the matched text unchanged".
    lookup: HashMap<String, Option<String>>,
}

impl CompiledDictionary {
    /// True when there is nothing to match, i.e. `apply_corrections` is identity.
    pub fn is_empty(&self) -> bool {
        self.matcher.is_none()
    }

    /// Terms in user creation order.
    pub fn terms(&self) -> &[String] {
        &self.terms
    }
}

/// Whisper's prompt is capped at roughly 224 tokens. We budget in CHARACTERS
/// rather than tokens (there is no tokenizer available at this layer), assuming
/// a pessimistic ~3 characters per token for short, unusual, heavily-split
/// vocabulary words. Anything past this budget is dropped rather than relying on
/// whisper.cpp to cut the list somewhere arbitrary.
pub const PROMPT_CHAR_BUDGET: usize = 500;

/// Compile dictionary rows into one matcher.
///
/// `entries` must arrive in user creation order (created_at ASC); that order is
/// preserved for the decoder prompt.
///
/// Every alias AND every term becomes an alternative in a single regex. Terms
/// are included so that already-correct text is RECOGNISED and passed through
/// untouched, which is what makes the function idempotent by construction: a
/// term can never be partially re-consumed by a shorter alias belonging to some
/// other entry.
///
/// Alternatives are sorted longest-first by pattern length. The regex crate uses
/// leftmost-first (preference order) alternation, so at any given position the
/// longest listed pattern wins. That is what settles cross-entry precedence:
/// with ("Node", alias "n eight") and ("n8n", alias "n eight n"), the input
/// "n eight n" matches the 9-character alias, not the 7-character one, and
/// yields "n8n" rather than "Node n". Sorting by TERM length, as an earlier
/// revision did, gets this backwards because the term length says nothing about
/// which alias will match the text.
///
/// Each pattern is regex-escaped (aliases are arbitrary user text and may
/// contain `.`, `+`, `(` and friends) and word-bounded.
pub fn compile_entries<I, S1, S2>(entries: I) -> CompiledDictionary
where
    I: IntoIterator<Item = (S1, Vec<S2>)>,
    S1: AsRef<str>,
    S2: AsRef<str>,
{
    let mut terms: Vec<String> = Vec::new();
    let mut alias_pairs: Vec<(String, String)> = Vec::new(); // (alias, term)

    for (term, aliases) in entries {
        let term = term.as_ref().trim().to_string();
        if term.is_empty() {
            continue;
        }

        for alias in aliases {
            let alias = alias.as_ref().trim().to_string();
            if alias.is_empty() {
                continue;
            }
            alias_pairs.push((alias, term.clone()));
        }

        terms.push(term);
    }

    // Terms are registered first and win any key collision, so a string that is
    // both a term and some other entry's alias is preserved rather than
    // rewritten. Case folding is UNICODE (`to_lowercase`), not ASCII: with the
    // entry ("Café", alias "CAFÉ") an ASCII fold would treat É and é as
    // different characters and register a self-referential rewrite.
    let mut lookup: HashMap<String, Option<String>> = HashMap::new();
    for term in &terms {
        lookup.insert(term.to_lowercase(), None);
    }
    for (alias, term) in &alias_pairs {
        let key = alias.to_lowercase();
        // An alias that folds onto its own term is a no-op rewrite; an alias
        // that folds onto ANY term is ambiguous and the term wins.
        lookup.entry(key).or_insert_with(|| Some(term.clone()));
    }

    // Longest pattern first, then lexicographic for a deterministic build.
    let mut patterns: Vec<&String> = lookup.keys().collect();
    patterns.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()).then(a.cmp(b)));

    let matcher = build_matcher(&patterns);

    CompiledDictionary {
        terms,
        matcher,
        lookup,
    }
}

/// Build the single alternation regex over every pattern.
///
/// Returns `None` when there is nothing to match, or when the combined pattern
/// fails to compile (e.g. an implausibly large dictionary exceeding the regex
/// size limit). A `None` matcher degrades to "no corrections", which is always
/// safe: the dictionary is an enhancement, never a correctness requirement.
fn build_matcher(patterns: &[&String]) -> Option<Regex> {
    if patterns.is_empty() {
        return None;
    }

    let alternation = patterns
        .iter()
        .map(|p| bounded_pattern(p))
        .collect::<Vec<_>>()
        .join("|");

    RegexBuilder::new(&alternation)
        .case_insensitive(true)
        .build()
        .ok()
}

/// Escape one pattern and wrap it in word boundaries.
///
/// A word boundary only asserts something useful next to a word character. A
/// pattern that starts or ends with punctuation (e.g. "+1" or "C++") would make
/// the boundary assert the opposite of what is intended, so it is applied
/// conditionally on each side. The result is wrapped in a non-capturing group so
/// it composes into the alternation safely.
fn bounded_pattern(pattern: &str) -> String {
    let escaped = regex::escape(pattern);
    let starts_word = pattern.chars().next().is_some_and(is_word_char);
    let ends_word = pattern.chars().last().is_some_and(is_word_char);

    format!(
        "(?:{}{}{})",
        if starts_word { r"\b" } else { "" },
        escaped,
        if ends_word { r"\b" } else { "" }
    )
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Rewrite every alias occurrence in `text` to its term, in ONE left-to-right
/// pass. PURE: no I/O, no globals, the same input always gives the same output.
/// This is what the transcription workers call on every segment.
///
/// Text that is already correct matches as a TERM and is emitted unchanged, so a
/// correct transcript is never damaged and no substitution can feed another
/// within the pass. Callers must still apply exactly one pass; see the
/// `CompiledDictionary` docs for the narrow shape in which a second pass is not
/// a no-op. An empty dictionary returns the input unchanged, which is the common
/// case and costs nothing.
pub fn apply_corrections(text: &str, dict: &CompiledDictionary) -> String {
    let matcher = match &dict.matcher {
        Some(m) => m,
        None => return text.to_string(),
    };
    if text.is_empty() {
        return String::new();
    }

    // A closure replacer inserts its return value LITERALLY, so a term
    // containing `$1` is never read as a capture reference.
    matcher
        .replace_all(text, |caps: &regex::Captures| {
            let matched = caps.get(0).map_or("", |m| m.as_str());
            match dict.lookup.get(&matched.to_lowercase()) {
                // An alias: emit its term.
                Some(Some(term)) => term.clone(),
                // A term: already correct, leave the user's text exactly as is.
                Some(None) => matched.to_string(),
                // Not reachable (every alternative came from `lookup`), but never
                // corrupt text on a lookup miss.
                None => matched.to_string(),
            }
        })
        .into_owned()
}

/// Comma-separated term list for a decoder prompt, capped at `char_budget`.
///
/// Terms are emitted in USER CREATION ORDER, not longest-first. Ordering by
/// length would make short, high-value terms (exactly the ones that get
/// mistranscribed, like "n8n") the first casualties of the cap.
///
/// Terms are emitted in order until the next one would not fit; the list is then
/// closed off rather than cut mid-term, so the prompt always ends on a complete
/// vocabulary word.
pub fn prompt_terms(dict: &CompiledDictionary, char_budget: usize) -> String {
    let mut out = String::new();
    for term in &dict.terms {
        let addition = if out.is_empty() {
            term.clone()
        } else {
            format!(", {}", term)
        };
        if out.chars().count() + addition.chars().count() > char_budget {
            break;
        }
        out.push_str(&addition);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict(pairs: &[(&str, &[&str])]) -> CompiledDictionary {
        compile_entries(
            pairs
                .iter()
                .map(|(t, a)| (t.to_string(), a.iter().map(|s| s.to_string()).collect()))
                .collect::<Vec<_>>(),
        )
    }

    // ─── Regression: the two defects that failed QA ──────────────────────────

    #[test]
    fn an_alias_that_is_a_prefix_of_its_own_term_does_not_duplicate_it() {
        // QA blocker: ("Claude Code", alias "Claude") used to turn
        // "ask Claude Code about it" into "ask Claude Code Code about it".
        let d = dict(&[("Claude Code", &["Claude"])]);

        assert_eq!(
            apply_corrections("ask Claude Code about it", &d),
            "ask Claude Code about it",
            "already-correct text must survive untouched"
        );
        assert_eq!(
            apply_corrections("ask Claude about it", &d),
            "ask Claude Code about it",
            "the bare alias must still be expanded"
        );
        // And expanding it once must be a fixed point.
        let once = apply_corrections("ask Claude about it", &d);
        assert_eq!(apply_corrections(&once, &d), once);
    }

    #[test]
    fn cross_entry_precedence_follows_alias_length_not_term_length() {
        // QA blocker: sorting entries by TERM length gave "Node n" here, because
        // "Node" (4 chars) outranked "n8n" (3) even though the matching alias
        // "n eight n" (9) is longer than "n eight" (7).
        let d = dict(&[("Node", &["n eight"]), ("n8n", &["n eight n"])]);
        assert_eq!(apply_corrections("we use n eight n daily", &d), "we use n8n daily");
        // The shorter alias still works where it is genuinely the longest match.
        assert_eq!(apply_corrections("we use n eight daily", &d), "we use Node daily");
    }

    #[test]
    fn case_folding_is_unicode_not_ascii() {
        // QA: ("Café", alias "CAFÉ"). An ASCII-only fold treats É and é as
        // distinct, registering CAFÉ as an alias of a term it already equals.
        let d = dict(&[("Café", &["CAFÉ"])]);

        // The accented term is recognised as a TERM in any casing, so the user's
        // own capitalisation is preserved rather than churned.
        assert_eq!(apply_corrections("meet at the CAFÉ", &d), "meet at the CAFÉ");
        assert_eq!(apply_corrections("meet at the Café", &d), "meet at the Café");
        // Stable under repetition, which is the property the fold protects.
        let once = apply_corrections("meet at the CAFÉ", &d);
        assert_eq!(apply_corrections(&once, &d), once);
    }

    #[test]
    fn an_accented_term_still_expands_a_genuine_alias() {
        let d = dict(&[("Café", &["caffay"])]);
        assert_eq!(apply_corrections("the caffay is open", &d), "the Café is open");
    }

    // ─── The original suite ─────────────────────────────────────────────────

    #[test]
    fn empty_dictionary_is_identity() {
        let text = "n eight n is a workflow tool";
        assert_eq!(apply_corrections(text, &dict(&[])), text);
    }

    #[test]
    fn empty_text_is_identity() {
        let d = dict(&[("n8n", &["n eight n"])]);
        assert_eq!(apply_corrections("", &d), "");
    }

    #[test]
    fn alias_inside_a_longer_word_is_not_replaced() {
        let d = dict(&[("Tandem", &["tandum"])]);
        // "tandums" and "xtandum" both embed the alias; word boundaries must hold.
        assert_eq!(
            apply_corrections("the tandums and xtandum stay", &d),
            "the tandums and xtandum stay"
        );
        // The standalone word is still corrected.
        assert_eq!(apply_corrections("open tandum now", &d), "open Tandem now");
    }

    #[test]
    fn matching_is_case_insensitive_and_output_takes_the_term_casing() {
        let d = dict(&[("Tandem", &["tandum"])]);
        assert_eq!(
            apply_corrections("TANDUM and Tandum", &d),
            "Tandem and Tandem"
        );
    }

    #[test]
    fn multi_word_aliases_are_replaced() {
        let d = dict(&[("n8n", &["n eight n"])]);
        assert_eq!(
            apply_corrections("we automate with n eight n daily", &d),
            "we automate with n8n daily"
        );
    }

    #[test]
    fn longest_alias_wins_over_a_shorter_prefix_alias() {
        let d = dict(&[("n8n", &["n eight n", "n eight"])]);
        assert_eq!(apply_corrections("run n eight n today", &d), "run n8n today");
    }

    #[test]
    fn surrounding_punctuation_is_preserved() {
        let d = dict(&[("n8n", &["n eight n"])]);
        assert_eq!(
            apply_corrections("Do you use \"n eight n\", really?", &d),
            "Do you use \"n8n\", really?"
        );
        assert_eq!(apply_corrections("n eight n.", &d), "n8n.");
    }

    #[test]
    fn the_term_itself_is_not_re_replaced() {
        let d = dict(&[("Tandem", &["Tandem", "tandem", "tandum"])]);
        assert_eq!(apply_corrections("Tandem is Tandem", &d), "Tandem is Tandem");
        assert_eq!(apply_corrections("tandum here", &d), "Tandem here");
    }

    #[test]
    fn regex_metacharacters_in_aliases_are_escaped() {
        let d = dict(&[("C++", &["see plus plus"]), ("dot net", &["dot.net"])]);
        assert_eq!(apply_corrections("I write see plus plus", &d), "I write C++");
        // "dotXnet" must NOT match: the dot is a literal, not "any char".
        assert_eq!(apply_corrections("dotXnet stays", &d), "dotXnet stays");
        assert_eq!(apply_corrections("dot.net changes", &d), "dot net changes");
    }

    #[test]
    fn replacement_text_with_dollar_signs_is_literal() {
        let d = dict(&[("$1 coin", &["one dollar coin"])]);
        assert_eq!(apply_corrections("a one dollar coin", &d), "a $1 coin");
    }

    #[test]
    fn entries_with_no_usable_aliases_are_kept_for_the_prompt() {
        let d = dict(&[("Excalidraw", &[]), ("", &["ignored"])]);
        assert_eq!(d.terms(), &["Excalidraw".to_string()], "blank terms are dropped");
        assert_eq!(apply_corrections("nothing changes", &d), "nothing changes");
    }

    #[test]
    fn corrections_are_stable_when_applied_twice() {
        // The worker applies corrections BEFORE the overlap-dedup tail compare,
        // so a segment and the tail it is compared against must converge to the
        // same text. Idempotence is what guarantees that.
        let d = dict(&[("n8n", &["n eight n"]), ("Tandem", &["tandum"])]);
        let once = apply_corrections("tandum runs n eight n", &d);
        assert_eq!(apply_corrections(&once, &d), once);
        assert_eq!(once, "Tandem runs n8n");
    }

    #[test]
    fn every_correction_is_a_fixed_point_across_a_mixed_dictionary() {
        // Broad idempotence guard: whatever the pass produces, running it again
        // must change nothing, for overlapping and prefix-sharing entries alike.
        let d = dict(&[
            ("Claude Code", &["Claude", "cloud code"]),
            ("n8n", &["n eight n", "innate"]),
            ("Node", &["n eight"]),
            ("Tandem", &["tandum"]),
        ]);
        for input in [
            "Claude Code and Claude and cloud code",
            "innate vs n eight n vs n eight",
            "tandum tandum Tandem",
            "nothing to correct here at all",
        ] {
            let once = apply_corrections(input, &d);
            assert_eq!(apply_corrections(&once, &d), once, "not a fixed point: {}", input);
        }
    }

    #[test]
    fn a_second_pass_is_not_guaranteed_stable_for_left_joining_aliases() {
        // Documents the boundary of the fixed-point property rather than a bug.
        // A replacement can land next to untouched text on its LEFT, and the
        // pair can form an alias the first pass never saw. Every live caller
        // applies exactly one pass, so this shape is unreachable in the app; the
        // test exists so a future caller that loops corrections finds out here.
        let d = dict(&[("why zed", &["ex"]), ("W", &["double why"])]);

        let once = apply_corrections("double ex here", &d);
        assert_eq!(once, "double why zed here", "one pass is what callers get");

        let twice = apply_corrections(&once, &d);
        assert_eq!(
            twice, "W zed here",
            "a second pass sees the newly adjacent \"double why\""
        );
        assert_ne!(once, twice, "this dictionary shape is not a fixed point");
    }

    // ─── Prompt assembly ────────────────────────────────────────────────────

    #[test]
    fn prompt_terms_keeps_user_creation_order() {
        // Explicitly NOT longest-first: a short term like "n8n" is exactly the
        // kind that must not be dropped first when the budget bites.
        let d = dict(&[("n8n", &[]), ("Excalidraw", &[]), ("Anthropic", &[])]);
        assert_eq!(prompt_terms(&d, 100), "n8n, Excalidraw, Anthropic");
    }

    #[test]
    fn prompt_terms_respects_the_budget_without_cutting_a_term() {
        let d = dict(&[("alpha", &[]), ("beta", &[]), ("gamma", &[])]);
        let all = prompt_terms(&d, 100);
        assert_eq!(all, "alpha, beta, gamma");

        let capped = prompt_terms(&d, 12);
        assert_eq!(capped, "alpha, beta");
        assert!(capped.chars().count() <= 12);
        assert!(!capped.ends_with(','), "must not cut mid-list: {}", capped);
    }

    #[test]
    fn prompt_terms_on_an_empty_dictionary_is_empty() {
        assert_eq!(prompt_terms(&dict(&[]), PROMPT_CHAR_BUDGET), "");
    }

    #[test]
    fn an_empty_dictionary_reports_itself_empty() {
        assert!(dict(&[]).is_empty());
        assert!(!dict(&[("n8n", &[])]).is_empty());
    }
}
