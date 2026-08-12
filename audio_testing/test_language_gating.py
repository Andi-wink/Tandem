"""Contract tests for the language gating ported into the WER harness.

The WER gate itself runs `evaluate()` with `pin_language=False`, so the pinned-language
path is never scored: inverting `english_post_processing_applies` still leaves the gate
green. These tests exist to close that hole, so they must fail loudly on an inversion.

The table below is the *executed* Rust behaviour of
`ParakeetEngine::english_post_processing_applies`
(frontend/src-tauri/src/parakeet_engine/parakeet_engine.rs), verified three ways in
results/p0_qa_parity.md. Note the deliberate traps: "en_US" (underscore, not hyphen),
"eng" (ISO-639-2) and "english" (plain word) are all NOT English, because the Rust
accepts only "" / "auto" / "auto-translate" / "en" / "en-*". That is arguably a wart
(a POSIX locale like en_US silently loses English post-processing) but it is the
shipped behaviour, so it is what is encoded here. Change the Rust first, then this.

Run:  PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest audio_testing/ -q
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from run_tandem_parakeet import (  # noqa: E402
    DOMAIN_TERMS,
    apply_domain_corrections,
    apply_phrase_corrections,
    collapse_runaways,
    english_post_processing_applies,
    postprocess,
)

# (language, expected) — mirrors the Rust predicate arm for arm.
ENGLISH_CASES = [
    (None, True),
    ("", True),
    ("   ", True),
    ("auto", True),
    ("AUTO", True),
    ("auto-translate", True),
    ("Auto-Translate", True),
    ("en", True),
    ("EN", True),
    (" en ", True),
    ("en-GB", True),
    ("en_US", False),   # trap: underscore is not the "en-" prefix
    ("eng", False),     # trap: ISO-639-2 is not accepted
    ("english", False),  # trap: the plain word is not accepted
    ("de", False),
    ("DE", False),
    ("de-DE", False),
]


@pytest.mark.parametrize("language,expected", ENGLISH_CASES)
def test_english_post_processing_applies(language, expected):
    assert english_post_processing_applies(language) is expected


def test_predicate_is_not_constant():
    """Guards against an implementation that always returns the same value."""
    results = {english_post_processing_applies(lang) for lang, _ in ENGLISH_CASES}
    assert results == {True, False}


# A synthetic token the fuzzy domain corrector demonstrably rewrites under English.
# (The real clips never trip it — see results/p0_qa_parity.md finding QA-3 — so a
# constructed input is the only way to test the gate rather than a no-op.)
DOMAIN_INPUT = "der workflw laeuft"
DOMAIN_EXPECTED_EN = "der workflow laeuft"

# The one phrase rule that fires on the real benchmark.
PHRASE_INPUT = "we run n a n locally"
PHRASE_EXPECTED_EN = "we run n8n locally"


def test_synthetic_domain_input_really_is_corrected():
    """Sanity: the fixture is not inert, otherwise the gating test proves nothing."""
    assert "workflow" in DOMAIN_TERMS
    assert apply_domain_corrections(DOMAIN_INPUT) == DOMAIN_EXPECTED_EN
    assert apply_domain_corrections(DOMAIN_INPUT) != DOMAIN_INPUT
    assert apply_phrase_corrections(PHRASE_INPUT) == PHRASE_EXPECTED_EN


@pytest.mark.parametrize("language", [None, "", "auto", "en", "EN", "en-GB"])
def test_postprocess_applies_corrections_for_english(language):
    assert postprocess(DOMAIN_INPUT, language=language) == DOMAIN_EXPECTED_EN
    assert postprocess(PHRASE_INPUT, language=language) == PHRASE_EXPECTED_EN


@pytest.mark.parametrize("language", ["de", "DE", "de-DE", "fr", "en_US", "eng", "english"])
def test_postprocess_skips_corrections_for_non_english(language):
    # Unchanged text, and specifically NOT the English-corrected form.
    assert postprocess(DOMAIN_INPUT, language=language) == DOMAIN_INPUT
    assert postprocess(DOMAIN_INPUT, language=language) != DOMAIN_EXPECTED_EN
    assert postprocess(PHRASE_INPUT, language=language) == PHRASE_INPUT


def test_postprocess_destutter_is_language_neutral():
    """#1 collapse_runaways must run on every language, unlike the domain pass."""
    stutter = "das ist ist ist gut"
    assert collapse_runaways(stutter) == "das ist gut"
    assert postprocess(stutter, language="de") == "das ist gut"
    assert postprocess(stutter, language="en") == "das ist gut"
