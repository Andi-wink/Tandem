"""
F005: Presidio PII Anonymization Pipeline

On-device PII anonymization using Microsoft Presidio + spaCy NER.
Anonymization happens at send-time (not storage-time): raw transcripts
stay local and real; only context basket payloads sent to the AI panel
are anonymized.

Two-tier detection:
  - Tier 1 (PERSON, EMAIL, PHONE, etc.): Faker surrogates (threshold 0.7)
  - Tier 2 (SSN, CREDIT_CARD, etc.): Hard-redacted to [TYPE] (threshold 0.3)
"""

import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from faker import Faker
from nameparser import HumanName
from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level initialization (loaded ONCE at import time)
# ---------------------------------------------------------------------------

# Candidate spaCy models, in preference order per language. Only the ones actually installed are
# loaded, so a machine without the German model degrades to English rather than failing to import.
#
# German matters specifically: the anonymizer was English-only until 2026-08-11, which meant that
# on a German client call (the calls with the strictest legal exposure) German names, orgs and
# locations were NOT detected before the context basket was sent to the AI panel. The anonymizer
# was inert on exactly the conversations it existed to protect.
_MODEL_CANDIDATES: dict[str, list[str]] = {
    "en": ["en_core_web_sm"],
    "de": ["de_core_news_sm"],
    "fr": ["fr_core_news_sm"],
    "es": ["es_core_news_sm"],
    "it": ["it_core_news_sm"],
    "nl": ["nl_core_news_sm"],
}


def _installed_models() -> list[dict[str, str]]:
    """Returns the spaCy models present on this machine, as Presidio nlp_configuration entries."""
    import importlib.util

    found = []
    for lang_code, candidates in _MODEL_CANDIDATES.items():
        for model_name in candidates:
            if importlib.util.find_spec(model_name) is not None:
                found.append({"lang_code": lang_code, "model_name": model_name})
                break
    return found


_models = _installed_models()
if not _models:
    # Preserve the historical default so the failure mode is an explicit load error rather than an
    # empty model list.
    _models = [{"lang_code": "en", "model_name": "en_core_web_sm"}]

_nlp_config = {"nlp_engine_name": "spacy", "models": _models}

# Languages the analyzer can actually serve. Anything else falls back to the default.
LOADED_LANGUAGES: list[str] = [m["lang_code"] for m in _models]
LOADED_MODELS: dict[str, str] = {m["lang_code"]: m["model_name"] for m in _models}

# German context words for the phone recognizer. Presidio scores a bare number at 0.4, below the
# 0.7 surrogate threshold, and only lifts it when a context word sits nearby. The built-in context
# list is English ("phone", "mobile", "cell"), so a German phone number in a German sentence stayed
# under threshold and was never surrogated.
_DE_PHONE_CONTEXT = [
    "telefon", "telefonnummer", "nummer", "rufnummer", "handy", "handynummer",
    "mobil", "mobilnummer", "durchwahl", "festnetz", "erreichbar", "anrufen", "tel",
]

try:
    _nlp_engine = NlpEngineProvider(nlp_configuration=_nlp_config).create_engine()
    _analyzer = AnalyzerEngine(
        nlp_engine=_nlp_engine, supported_languages=LOADED_LANGUAGES
    )

    if "de" in LOADED_LANGUAGES:
        try:
            from presidio_analyzer.predefined_recognizers import PhoneRecognizer

            _analyzer.registry.add_recognizer(
                PhoneRecognizer(
                    context=_DE_PHONE_CONTEXT,
                    supported_language="de",
                    supported_regions=("DE", "AT", "CH", "US", "UK"),
                )
            )
        except Exception as e:  # non-fatal: German NER still works without it
            logger.warning("Could not register German phone recognizer: %s", e)

    _anonymizer_engine = AnonymizerEngine()
    _presidio_available = True
    logger.info(
        "Presidio PII anonymizer initialized (models: %s)",
        ", ".join(f"{k}={v}" for k, v in LOADED_MODELS.items()),
    )
except Exception as e:
    _analyzer = None
    _anonymizer_engine = None
    _presidio_available = False
    LOADED_LANGUAGES = []
    LOADED_MODELS = {}
    logger.warning("Presidio not available: %s. Anonymization disabled.", e)

# ---------------------------------------------------------------------------
# Entity configuration
# ---------------------------------------------------------------------------

SURROGATE_ENTITIES = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "LOCATION",
    "URL",
    "IP_ADDRESS",
]
SURROGATE_THRESHOLD = 0.7

REDACT_ENTITIES = [
    "CREDIT_CARD",
    "US_SSN",
    "US_ITIN",
    "US_BANK_NUMBER",
    "IBAN_CODE",
    "CRYPTO",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
    "MEDICAL_LICENSE",
]
REDACT_THRESHOLD = 0.3

ALL_ENTITIES = SURROGATE_ENTITIES + REDACT_ENTITIES

# Default analysis language (Presidio/spaCy language code). Used when the caller does not name
# one, and as the fallback when a requested language has no model installed.
ANALYSIS_LANGUAGE = os.environ.get("TANDEM_PII_LANGUAGE", "en")

# Languages already warned about, so an unsupported request logs once rather than per chunk.
_warned_languages: set[str] = set()

# German function words that are rare-to-absent in English. Used only to pick between models we
# have actually loaded, never to reject text.
_GERMAN_MARKERS = frozenset(
    """der die das und ist nicht ich wir sie mit für auf von dem den des eine einen einem
       auch noch schon aber oder wenn dann weil dass wie was wer wo sehr mehr sind war
       haben hat hatte werden wird wurde kann können muss müssen soll sollen ja nein
       vielen danke bitte genau also über unter zwischen""".split()
)


def _looks_german(text: str) -> bool:
    """Cheap German detector for the 'auto' case: umlaut/ß density plus function-word hits.

    Deliberately dependency-free and deliberately conservative. It only ever chooses between
    models that are already loaded, and a wrong answer degrades detection quality rather than
    breaking anything. It is not a general language identifier and should not be used as one.
    """
    if not text:
        return False
    lowered = text.lower()
    if any(ch in lowered for ch in "äöüß"):
        return True
    words = re.findall(r"[a-zäöüß]+", lowered)
    if len(words) < 8:
        # Too short to judge; do not guess.
        return False
    hits = sum(1 for w in words if w in _GERMAN_MARKERS)
    return hits / len(words) >= 0.12


def _resolve_language(requested: Optional[str], text: str = "") -> str:
    """Picks the analysis language actually used for a call.

    - None / "" / "auto" / "auto-translate": sniff the text, else fall back to the default.
    - An explicit code with a loaded model: use it.
    - An explicit code with no model: warn once, fall back to the default.
    """
    default = ANALYSIS_LANGUAGE if ANALYSIS_LANGUAGE in LOADED_LANGUAGES else (
        LOADED_LANGUAGES[0] if LOADED_LANGUAGES else "en"
    )

    code = (requested or "").strip().lower()
    code = code.split("-")[0].split("_")[0]

    if code in ("", "auto", "autotranslate"):
        if "de" in LOADED_LANGUAGES and _looks_german(text):
            return "de"
        return default

    if code in LOADED_LANGUAGES:
        return code

    if code not in _warned_languages:
        _warned_languages.add(code)
        logger.warning(
            "No spaCy model installed for language '%s' (have: %s). "
            "Falling back to '%s'. Install with: python -m spacy download %s",
            code,
            ", ".join(LOADED_LANGUAGES) or "none",
            default,
            _MODEL_CANDIDATES.get(code, ["<unknown model>"])[0],
        )
    return default


def _analyze(text: str, language: Optional[str]) -> list[RecognizerResult]:
    """Single entry point for Presidio analysis, so language resolution happens in one place."""
    return _analyzer.analyze(
        text=text,
        entities=ALL_ENTITIES,
        language=_resolve_language(language, text),
    )

# UUID pattern for false-positive filtering
_UUID_PATTERN = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# ---------------------------------------------------------------------------
# Name Clusterer (Union-Find)
# ---------------------------------------------------------------------------


class NameClusterer:
    """Groups name variants using Union-Find with nameparser heuristics.

    Examples: "John Smith", "Mr. Smith", "John" → same cluster → same surrogate.
    """

    # Common nickname → canonical mappings
    NICKNAMES = {
        "johnny": "john", "jon": "john", "jack": "john",
        "danny": "daniel", "dan": "daniel",
        "mike": "michael", "mikey": "michael",
        "rob": "robert", "bob": "robert", "bobby": "robert",
        "will": "william", "bill": "william", "billy": "william",
        "dick": "richard", "rick": "richard", "rich": "richard",
        "jim": "james", "jimmy": "james", "jamie": "james",
        "tom": "thomas", "tommy": "thomas",
        "steve": "stephen", "stevo": "stephen",
        "dave": "david", "davy": "david",
        "chris": "christopher", "kit": "christopher",
        "ed": "edward", "ted": "edward", "teddy": "edward",
        "joe": "joseph", "joey": "joseph",
        "sam": "samuel", "sammy": "samuel",
        "alex": "alexander", "al": "alexander",
        "charlie": "charles", "chuck": "charles",
        "matt": "matthew",
        "nick": "nicholas",
        "pat": "patrick",
        "tony": "anthony",
        "ben": "benjamin",
        "andy": "andrew", "drew": "andrew",
        "jen": "jennifer", "jenny": "jennifer",
        "kate": "katherine", "katie": "katherine", "kathy": "katherine",
        "liz": "elizabeth", "beth": "elizabeth", "betty": "elizabeth",
        "meg": "margaret", "maggie": "margaret", "peggy": "margaret",
        "sue": "susan", "susie": "susan",
    }

    def __init__(self):
        self._parent: dict[str, str] = {}
        self._parsed: dict[str, HumanName] = {}

    def _canonical_first(self, first: str) -> str:
        return self.NICKNAMES.get(first.lower(), first.lower())

    def _parse(self, name: str) -> HumanName:
        if name not in self._parsed:
            self._parsed[name] = HumanName(name)
        return self._parsed[name]

    def find(self, name: str) -> str:
        if name not in self._parent:
            self._parent[name] = name
        if self._parent[name] != name:
            self._parent[name] = self.find(self._parent[name])
        return self._parent[name]

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self._parent[rb] = ra

    def cluster(self, names: list[str]) -> None:
        """Attempt to merge name variants."""
        parsed = [(n, self._parse(n)) for n in names]

        for i, (n1, h1) in enumerate(parsed):
            for n2, h2 in parsed[i + 1:]:
                if self._are_related(h1, h2):
                    self.union(n1, n2)

    def _are_related(self, a: HumanName, b: HumanName) -> bool:
        # Rule 1: same canonical first + last
        if (
            a.last and b.last
            and a.first and b.first
            and a.last.lower() == b.last.lower()
            and self._canonical_first(a.first) == self._canonical_first(b.first)
        ):
            return True

        # Rule 2: same last name, one is just last name or titled
        if (
            a.last and b.last
            and a.last.lower() == b.last.lower()
            and (not a.first or not b.first)
        ):
            return True

        # Rule 3: lone first name matches canonical first of a full name
        if a.first and not a.last and b.first and b.last:
            if self._canonical_first(a.first) == self._canonical_first(b.first):
                return True
        if b.first and not b.last and a.first and a.last:
            if self._canonical_first(b.first) == self._canonical_first(a.first):
                return True

        return False

    def get_cluster_root(self, name: str) -> str:
        return self.find(name)


# ---------------------------------------------------------------------------
# Entity Registry (per-meeting alias map)
# ---------------------------------------------------------------------------


@dataclass
class EntityRegistry:
    """Maintains consistent mapping of real→surrogate values within a meeting."""

    meeting_id: str
    _map: dict[str, str] = field(default_factory=dict)
    _reverse: dict[str, str] = field(default_factory=dict)
    _faker: Faker = field(default=None, repr=False)
    _clusterer: NameClusterer = field(default_factory=NameClusterer, repr=False)

    def __post_init__(self):
        # Seed Faker per-instance (not global Faker.seed()) to avoid race conditions
        seed = hash(self.meeting_id) % (2**32)
        self._faker = Faker()
        self._faker.seed_instance(seed)

    @property
    def entity_map(self) -> dict[str, str]:
        return dict(self._map)

    def load(self, entity_map: dict[str, str]) -> None:
        self._map.update(entity_map)
        for real, surrogate in entity_map.items():
            self._reverse[surrogate] = real

    def get_surrogate(self, real_value: str, entity_type: str) -> str:
        """Get or create a surrogate for a real value."""
        # Check cluster root first (for name variants)
        if entity_type == "PERSON":
            root = self._clusterer.get_cluster_root(real_value)
            if root in self._map:
                return self._derive_sub_surrogate(real_value, root)

        if real_value in self._map:
            return self._map[real_value]

        surrogate = self._generate_surrogate(entity_type)
        self._map[real_value] = surrogate
        self._reverse[surrogate] = real_value
        return surrogate

    def _generate_surrogate(self, entity_type: str) -> str:
        """Generate a Faker-based surrogate, avoiding collisions."""
        for _ in range(50):  # max attempts
            if entity_type == "PERSON":
                candidate = self._faker.name()
            elif entity_type == "EMAIL_ADDRESS":
                candidate = self._faker.safe_email()
            elif entity_type == "PHONE_NUMBER":
                candidate = self._faker.phone_number()
            elif entity_type == "LOCATION":
                candidate = self._faker.city()
            elif entity_type == "URL":
                candidate = self._faker.url()
            elif entity_type == "IP_ADDRESS":
                candidate = self._faker.ipv4()
            elif entity_type == "DATE_TIME":
                candidate = self._faker.date()
            else:
                candidate = f"[{entity_type}]"
                return candidate

            if candidate not in self._reverse:
                return candidate

        return f"[{entity_type}_{len(self._map)}]"

    def _derive_sub_surrogate(self, variant: str, cluster_root: str) -> str:
        """Derive a sub-surrogate for a name variant.

        If "John Smith" → "Marcus Webb", then "Mr. Smith" → "Mr. Webb".
        """
        if variant in self._map:
            return self._map[variant]

        root_surrogate = self._map[cluster_root]
        root_parsed = HumanName(cluster_root)
        variant_parsed = HumanName(variant)
        surrogate_parsed = HumanName(root_surrogate)

        parts = []
        if variant_parsed.title:
            parts.append(variant_parsed.title)
        if variant_parsed.first and root_parsed.first:
            parts.append(surrogate_parsed.first or surrogate_parsed.last)
        if variant_parsed.last and root_parsed.last:
            parts.append(surrogate_parsed.last or surrogate_parsed.first)

        derived = " ".join(parts) if parts else root_surrogate
        self._map[variant] = derived
        self._reverse[derived] = variant
        return derived

    def cluster_names(self, names: list[str]) -> None:
        self._clusterer.cluster(names)

    def save_to_file(self, base_dir: str) -> None:
        """Persist entity map to .tandem/entity_map.json."""
        tandem_dir = Path(base_dir) / ".tandem"
        tandem_dir.mkdir(parents=True, exist_ok=True)
        path = tandem_dir / "entity_map.json"
        path.write_text(json.dumps(self._map, indent=2, ensure_ascii=False))
        logger.info("Saved entity map (%d entries) to %s", len(self._map), path)

    @classmethod
    def load_from_file(cls, meeting_id: str, base_dir: str) -> "EntityRegistry":
        """Load entity map from .tandem/entity_map.json if it exists."""
        registry = cls(meeting_id=meeting_id)
        path = Path(base_dir) / ".tandem" / "entity_map.json"
        if path.exists():
            try:
                data = json.loads(path.read_text())
                registry.load(data)
                logger.info("Loaded entity map (%d entries) from %s", len(data), path)
            except Exception as e:
                logger.warning("Failed to load entity map: %s", e)
        return registry


# ---------------------------------------------------------------------------
# UUID false-positive filter
# ---------------------------------------------------------------------------


def _filter_uuid_false_positives(
    text: str, results: list[RecognizerResult]
) -> list[RecognizerResult]:
    """Remove Presidio detections that fall within UUID patterns."""
    uuid_spans = [(m.start(), m.end()) for m in _UUID_PATTERN.finditer(text)]
    if not uuid_spans:
        return results

    filtered = []
    for r in results:
        overlaps = any(
            us <= r.start < ue or us < r.end <= ue for us, ue in uuid_spans
        )
        if not overlaps:
            filtered.append(r)
        else:
            logger.debug("Filtered UUID false positive: %s at [%d:%d]", r.entity_type, r.start, r.end)

    return filtered


# ---------------------------------------------------------------------------
# JSON-aware anonymization
# ---------------------------------------------------------------------------


def _anonymize_json_values(
    obj: Any, registry: EntityRegistry, language: Optional[str] = None
) -> Any:
    """Recursively anonymize string values in JSON, preserving structure.

    Note: JSON values are individual strings (not the original text), so we
    can't pre-compute analysis for these. Each string value is analyzed once.
    """
    if isinstance(obj, str):
        anonymized, _results = _anonymize_text_segment(obj, registry, language=language)
        return anonymized
    elif isinstance(obj, dict):
        return {k: _anonymize_json_values(v, registry, language) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_anonymize_json_values(item, registry, language) for item in obj]
    else:
        return obj  # numbers, booleans, null — pass through


def _anonymize_text_segment(
    text: str,
    registry: EntityRegistry,
    precomputed_results: list[RecognizerResult] | None = None,
    language: Optional[str] = None,
) -> tuple[str, list[RecognizerResult]]:
    """Anonymize a single text string using Presidio.

    Args:
        text: The text to anonymize.
        registry: Entity registry for consistent surrogates.
        precomputed_results: Pre-analyzed Presidio results (already UUID-filtered).
            If provided, skips the analysis call.

    Returns:
        Tuple of (anonymized_text, filtered_results) so callers can reuse
        the analysis for reporting without re-analyzing.
    """
    if not _presidio_available or not text.strip():
        return text, []

    if precomputed_results is not None:
        results = precomputed_results
    else:
        results = _analyze(text, language)
        results = _filter_uuid_false_positives(text, results)

    # Apply thresholds
    filtered = []
    for r in results:
        if r.entity_type in SURROGATE_ENTITIES and r.score >= SURROGATE_THRESHOLD:
            filtered.append(r)
        elif r.entity_type in REDACT_ENTITIES and r.score >= REDACT_THRESHOLD:
            filtered.append(r)

    if not filtered:
        return text, filtered

    # Sort by start position descending so we can replace from end to start
    filtered.sort(key=lambda r: r.start, reverse=True)

    result = text
    for r in filtered:
        original = text[r.start:r.end]
        if r.entity_type in REDACT_ENTITIES:
            replacement = f"[{r.entity_type}]"
        else:
            replacement = registry.get_surrogate(original, r.entity_type)
        result = result[:r.start] + replacement + result[r.end:]

    return result, filtered


def _try_parse_json_block(text: str) -> tuple[Any, bool]:
    """Try to parse text as JSON. Returns (parsed, success)."""
    stripped = text.strip()
    if not (stripped.startswith("{") or stripped.startswith("[")):
        return None, False
    try:
        return json.loads(stripped), True
    except (json.JSONDecodeError, ValueError):
        return None, False


# ---------------------------------------------------------------------------
# Main anonymization function
# ---------------------------------------------------------------------------

# In-memory registries keyed by meeting_id, with last-access timestamps
_registries: dict[str, EntityRegistry] = {}
_registry_last_access: dict[str, float] = {}
_REGISTRY_TTL_SECS = 2 * 60 * 60  # 2 hours
_REGISTRY_MAX_SIZE = 100  # LRU cap


def _cleanup_expired_registries() -> None:
    """Evict registries inactive for more than _REGISTRY_TTL_SECS."""
    now = time.monotonic()
    expired = [mid for mid, ts in _registry_last_access.items()
               if now - ts > _REGISTRY_TTL_SECS]
    for mid in expired:
        _registries.pop(mid, None)
        _registry_last_access.pop(mid, None)
        logger.info("Evicted expired entity registry for meeting %s", mid)


def _evict_lru_if_needed() -> None:
    """If registries exceed max size, evict the least recently used."""
    while len(_registries) > _REGISTRY_MAX_SIZE:
        oldest = min(_registry_last_access, key=_registry_last_access.get)
        _registries.pop(oldest, None)
        _registry_last_access.pop(oldest, None)
        logger.info("Evicted LRU entity registry for meeting %s", oldest)


def get_registry(meeting_id: str, entity_map: Optional[dict] = None) -> EntityRegistry:
    """Get or create an EntityRegistry for a meeting."""
    _cleanup_expired_registries()
    if meeting_id not in _registries:
        _evict_lru_if_needed()
        _registries[meeting_id] = EntityRegistry(meeting_id=meeting_id)
    _registry_last_access[meeting_id] = time.monotonic()
    registry = _registries[meeting_id]
    if entity_map:
        registry.load(entity_map)
    return registry


def clear_registry(meeting_id: str) -> None:
    """Clear the entity registry for a meeting."""
    _registries.pop(meeting_id, None)
    _registry_last_access.pop(meeting_id, None)


def get_entity_map(meeting_id: str) -> dict[str, str]:
    """Get the current entity map for a meeting."""
    if meeting_id in _registries:
        _registry_last_access[meeting_id] = time.monotonic()
        return _registries[meeting_id].entity_map
    return {}


def get_reverse_map(meeting_id: str) -> dict[str, str]:
    """Get the surrogate-to-real mapping for de-anonymization.

    Returns a dict mapping surrogate values back to their original real values.
    Useful for de-anonymizing AI responses before displaying to the user.
    """
    if meeting_id in _registries:
        _registry_last_access[meeting_id] = time.monotonic()
        return dict(_registries[meeting_id]._reverse)
    return {}


async def anonymize_text(
    text: str,
    meeting_id: str,
    entity_map: Optional[dict[str, str]] = None,
    detect_json: bool = True,
    language: Optional[str] = None,
) -> tuple[str, dict[str, str], list[dict]]:
    """Anonymize PII in text.

    Args:
        text: The text to anonymize.
        meeting_id: Meeting identifier for consistent surrogates.
        entity_map: Optional existing entity map to extend.
        detect_json: Whether to detect and handle JSON blocks specially.
        language: Analysis language (ISO-639-1, or the "auto" sentinels). Pass the meeting's
            transcription language so German calls get German NER. Falls back to sniffing the
            text, then to ANALYSIS_LANGUAGE.

    Returns:
        Tuple of (anonymized_text, updated_entity_map, entities_found).
    """
    if not _presidio_available:
        logger.warning("Presidio not available, returning text unchanged")
        return text, entity_map or {}, []

    registry = get_registry(meeting_id, entity_map)

    # Single analysis pass for the full text — reused for clustering,
    # anonymization, and entity reporting (avoids 3x redundant calls).
    all_results = _analyze(text, language)
    all_results = _filter_uuid_false_positives(text, all_results)

    # Extract PERSON names from the single pass for clustering
    person_names = [
        text[r.start:r.end]
        for r in all_results
        if r.entity_type == "PERSON" and r.score >= SURROGATE_THRESHOLD
    ]
    if person_names:
        registry.cluster_names(person_names)

    # Handle JSON blocks specially (JSON values are re-parsed individually,
    # but we still reuse all_results for entity reporting on the raw text)
    if detect_json:
        parsed, is_json = _try_parse_json_block(text)
        if is_json:
            anonymized_obj = _anonymize_json_values(parsed, registry, language)
            anonymized_text = json.dumps(anonymized_obj, indent=2, ensure_ascii=False)
            # Use _anonymize_text_segment just for threshold filtering to
            # get the filtered results for reporting, without re-analyzing
            _anon_unused, filtered_results = _anonymize_text_segment(
                text, registry, precomputed_results=all_results
            )
            entities_found = _collect_entities_found(
                text, registry, precomputed_results=filtered_results
            )
            return anonymized_text, registry.entity_map, entities_found

    # Standard text anonymization — pass precomputed results
    anonymized_text, filtered_results = _anonymize_text_segment(
        text, registry, precomputed_results=all_results
    )
    entities_found = _collect_entities_found(
        text, registry, precomputed_results=filtered_results
    )

    return anonymized_text, registry.entity_map, entities_found


async def anonymize_texts(
    texts: list[str],
    meeting_id: str,
    entity_map: Optional[dict[str, str]] = None,
    detect_json: bool = True,
    language: Optional[str] = None,
) -> tuple[list[str], dict[str, str], list[dict]]:
    """Anonymize PII in multiple texts (batch).

    Uses a shared entity registry so surrogates are consistent across all texts.

    `language` is the analysis language (ISO-639-1, or the "auto" sentinels). Resolution is
    per-text, so a mixed batch still gets the right model per segment.
    """
    if not _presidio_available:
        return texts, entity_map or {}, []

    registry = get_registry(meeting_id, entity_map)

    # Single analysis pass per text — reused for clustering, anonymization,
    # and entity reporting (avoids 3x redundant calls per text).
    per_text_results: list[list[RecognizerResult]] = []
    all_person_names: list[str] = []
    for text in texts:
        results = _analyze(text, language)
        results = _filter_uuid_false_positives(text, results)
        per_text_results.append(results)
        all_person_names.extend(
            text[r.start:r.end]
            for r in results
            if r.entity_type == "PERSON" and r.score >= SURROGATE_THRESHOLD
        )
    if all_person_names:
        registry.cluster_names(all_person_names)

    # Anonymize each text using precomputed results
    sanitized = []
    all_entities: list[dict] = []
    for text, text_results in zip(texts, per_text_results):
        if detect_json:
            parsed, is_json = _try_parse_json_block(text)
            if is_json:
                anon_obj = _anonymize_json_values(parsed, registry, language)
                sanitized.append(json.dumps(anon_obj, indent=2, ensure_ascii=False))
                # Get filtered results for reporting without re-analyzing
                _anon_unused, filtered = _anonymize_text_segment(
                    text, registry, precomputed_results=text_results
                )
                all_entities.extend(
                    _collect_entities_found(text, registry, precomputed_results=filtered)
                )
                continue

        anonymized, filtered = _anonymize_text_segment(
            text, registry, precomputed_results=text_results
        )
        sanitized.append(anonymized)
        all_entities.extend(
            _collect_entities_found(text, registry, precomputed_results=filtered)
        )

    return sanitized, registry.entity_map, all_entities


def _collect_entities_found(
    text: str,
    registry: EntityRegistry,
    precomputed_results: list[RecognizerResult] | None = None,
    language: Optional[str] = None,
) -> list[dict]:
    """Collect a summary of entities found in text.

    Args:
        text: The original (non-anonymized) text to report on.
        registry: Entity registry (unused currently, kept for API consistency).
        precomputed_results: Pre-analyzed Presidio results (already UUID-filtered
            and threshold-applied). If provided, skips the analysis call.
    """
    if not _presidio_available:
        return []

    if precomputed_results is not None:
        # Results are already filtered by threshold — just build the report
        entities = []
        for r in precomputed_results:
            original = text[r.start:r.end]
            entities.append({
                "entity_type": r.entity_type,
                "original": original,
                "score": round(r.score, 2),
                "start": r.start,
                "end": r.end,
            })
        return entities

    # Fallback: full analysis (for callers without precomputed results)
    results = _analyze(text, language)
    results = _filter_uuid_false_positives(text, results)

    entities = []
    for r in results:
        threshold = (
            SURROGATE_THRESHOLD if r.entity_type in SURROGATE_ENTITIES
            else REDACT_THRESHOLD
        )
        if r.score >= threshold:
            original = text[r.start:r.end]
            entities.append({
                "entity_type": r.entity_type,
                "original": original,
                "score": round(r.score, 2),
                "start": r.start,
                "end": r.end,
            })
    return entities


def is_available() -> bool:
    """Check if the Presidio anonymizer is available."""
    return _presidio_available
