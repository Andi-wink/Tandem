// F056: Custom Transcription Dictionary.
//
// A user-editable list of terms that speech-to-text keeps getting wrong
// ("n8n" heard as "n eight n", "Tandem" as "tandum"). It is applied in two
// independent places, because neither alone is sufficient:
//
//   1. DECODER BIAS. The term list is appended to the Whisper `initial_prompt`
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

/// One dictionary term with its aliases pre-compiled into match regexes.
#[derive(Debug, Clone)]
pub struct CompiledEntry {
    /// The correct spelling every matching alias is rewritten to.
    pub term: String,
    /// One regex per alias, longest alias first (see `compile_entries`).
    pub patterns: Vec<Regex>,
}

/// Whisper's prompt is capped at roughly 224 tokens. We budget in CHARACTERS
/// rather than tokens (there is no tokenizer available at this layer), assuming
/// a pessimistic ~3 characters per token for short, unusual, heavily-split
/// vocabulary words. Anything past this budget is dropped rather than risking
/// whisper.cpp truncating the prompt at an arbitrary point.
pub const PROMPT_CHAR_BUDGET: usize = 500;

/// Compile dictionary rows into match regexes.
///
/// Ordering matters: within an entry, aliases are sorted LONGEST FIRST so that a
/// multi-word alias ("n eight n") wins over a shorter alias that is a prefix of
/// it ("n eight"), which would otherwise consume part of the longer match.
///
/// Each alias is regex-escaped (aliases are arbitrary user text and may contain
/// `.`, `+`, `(` and friends) and wrapped in word boundaries, so an alias never
/// fires inside a longer word. An alias that is empty, equal to the term, or
/// whose escaped form fails to compile is skipped rather than poisoning the
/// whole entry.
pub fn compile_entries<I, S1, S2>(entries: I) -> Vec<CompiledEntry>
where
    I: IntoIterator<Item = (S1, Vec<S2>)>,
    S1: AsRef<str>,
    S2: AsRef<str>,
{
    let mut compiled = Vec::new();

    for (term, aliases) in entries {
        let term = term.as_ref().trim().to_string();
        if term.is_empty() {
            continue;
        }

        let mut alias_list: Vec<String> = aliases
            .into_iter()
            .map(|a| a.as_ref().trim().to_string())
            .filter(|a| !a.is_empty())
            // An alias identical to the term is a no-op rewrite; dropping it
            // keeps the term from being re-replaced onto itself.
            .filter(|a| !a.eq_ignore_ascii_case(&term))
            .collect();

        // Longest first, then alphabetical for a stable, deterministic order.
        alias_list.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()).then(a.cmp(b)));
        alias_list.dedup();

        let patterns: Vec<Regex> = alias_list
            .iter()
            .filter_map(|alias| build_alias_regex(alias))
            .collect();

        // An entry with no usable aliases is still kept: it contributes to the
        // decoder prompt even though it has nothing to post-correct.
        compiled.push(CompiledEntry { term, patterns });
    }

    // Longest term first across entries too, so a term that contains another
    // term's alias is settled predictably.
    compiled.sort_by(|a, b| b.term.chars().count().cmp(&a.term.chars().count()));
    compiled
}

/// Build the whole-word, case-insensitive regex for one alias.
///
/// A word boundary only asserts something useful next to a word character. An
/// alias that starts or ends with punctuation (e.g. "+1" or "n8n.") would make
/// the boundary assert the opposite of what is intended, so it is applied
/// conditionally on each side.
fn build_alias_regex(alias: &str) -> Option<Regex> {
    let escaped = regex::escape(alias);

    let starts_word = alias.chars().next().map_or(false, is_word_char);
    let ends_word = alias.chars().last().map_or(false, is_word_char);

    let pattern = format!(
        "{}{}{}",
        if starts_word { r"\b" } else { "" },
        escaped,
        if ends_word { r"\b" } else { "" }
    );

    RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .ok()
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Rewrite every alias occurrence in `text` to its term. PURE: no I/O, no
/// globals, the same input always gives the same output. This is what the
/// transcription worker calls on every segment.
///
/// An empty dictionary returns the input unchanged (identity), which is the
/// common case and costs nothing.
pub fn apply_corrections(text: &str, entries: &[CompiledEntry]) -> String {
    if entries.is_empty() || text.is_empty() {
        return text.to_string();
    }

    let mut out = text.to_string();
    for entry in entries {
        for pattern in &entry.patterns {
            // Literal replacement via NoExpand, so a term containing `$1` is
            // inserted verbatim instead of being read as a capture reference.
            if pattern.is_match(&out) {
                out = pattern
                    .replace_all(&out, regex::NoExpand(entry.term.as_str()))
                    .into_owned();
            }
        }
    }
    out
}

/// Comma-separated term list for a decoder prompt, capped at `char_budget`.
///
/// Terms are emitted in order until the next one would not fit; the list is then
/// closed off rather than cut mid-term, so the prompt always ends on a complete
/// vocabulary word.
pub fn prompt_terms(entries: &[CompiledEntry], char_budget: usize) -> String {
    let mut out = String::new();
    for entry in entries {
        let addition = if out.is_empty() {
            entry.term.clone()
        } else {
            format!(", {}", entry.term)
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

    fn dict(pairs: &[(&str, &[&str])]) -> Vec<CompiledEntry> {
        compile_entries(
            pairs
                .iter()
                .map(|(t, a)| (t.to_string(), a.iter().map(|s| s.to_string()).collect()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn empty_dictionary_is_identity() {
        let text = "n eight n is a workflow tool";
        assert_eq!(apply_corrections(text, &[]), text);
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
        // An alias equal to the term (any casing) is dropped at compile time, so
        // already-correct text passes through untouched and cannot loop.
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
        assert_eq!(d.len(), 1, "blank terms are dropped");
        assert_eq!(d[0].term, "Excalidraw");
        assert_eq!(apply_corrections("nothing changes", &d), "nothing changes");
    }

    #[test]
    fn prompt_terms_joins_and_respects_the_budget() {
        let d = dict(&[("alpha", &[]), ("beta", &[]), ("gamma", &[])]);
        let all = prompt_terms(&d, 100);
        assert!(all.contains("alpha") && all.contains("beta") && all.contains("gamma"));
        assert_eq!(all.matches(", ").count(), 2);

        let capped = prompt_terms(&d, 7);
        assert!(capped.chars().count() <= 7);
        assert!(!capped.ends_with(','), "must not cut mid-list: {}", capped);
    }

    #[test]
    fn prompt_terms_on_an_empty_dictionary_is_empty() {
        assert_eq!(prompt_terms(&[], PROMPT_CHAR_BUDGET), "");
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
}
