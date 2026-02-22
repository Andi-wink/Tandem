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
import re
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

_nlp_config = {
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
}

try:
    _nlp_engine = NlpEngineProvider(nlp_configuration=_nlp_config).create_engine()
    _analyzer = AnalyzerEngine(nlp_engine=_nlp_engine)
    _anonymizer_engine = AnonymizerEngine()
    _presidio_available = True
    logger.info("Presidio PII anonymizer initialized (model: en_core_web_sm)")
except Exception as e:
    _analyzer = None
    _anonymizer_engine = None
    _presidio_available = False
    logger.warning("Presidio not available: %s. Anonymization disabled.", e)

# ---------------------------------------------------------------------------
# Entity configuration
# ---------------------------------------------------------------------------

SURROGATE_ENTITIES = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "LOCATION",
    "DATE_TIME",
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
        # Seed Faker with meeting_id for reproducibility
        seed = hash(self.meeting_id) % (2**32)
        self._faker = Faker()
        Faker.seed(seed)

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


def _anonymize_json_values(obj: Any, registry: EntityRegistry) -> Any:
    """Recursively anonymize string values in JSON, preserving structure."""
    if isinstance(obj, str):
        return _anonymize_text_segment(obj, registry)
    elif isinstance(obj, dict):
        return {k: _anonymize_json_values(v, registry) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_anonymize_json_values(item, registry) for item in obj]
    else:
        return obj  # numbers, booleans, null — pass through


def _anonymize_text_segment(text: str, registry: EntityRegistry) -> str:
    """Anonymize a single text string using Presidio."""
    if not _presidio_available or not text.strip():
        return text

    results = _analyzer.analyze(
        text=text,
        entities=ALL_ENTITIES,
        language="en",
    )
    results = _filter_uuid_false_positives(text, results)

    # Apply thresholds
    filtered = []
    for r in results:
        if r.entity_type in SURROGATE_ENTITIES and r.score >= SURROGATE_THRESHOLD:
            filtered.append(r)
        elif r.entity_type in REDACT_ENTITIES and r.score >= REDACT_THRESHOLD:
            filtered.append(r)

    if not filtered:
        return text

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

    return result


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

# In-memory registries keyed by meeting_id
_registries: dict[str, EntityRegistry] = {}


def get_registry(meeting_id: str, entity_map: Optional[dict] = None) -> EntityRegistry:
    """Get or create an EntityRegistry for a meeting."""
    if meeting_id not in _registries:
        _registries[meeting_id] = EntityRegistry(meeting_id=meeting_id)
    registry = _registries[meeting_id]
    if entity_map:
        registry.load(entity_map)
    return registry


def clear_registry(meeting_id: str) -> None:
    """Clear the entity registry for a meeting."""
    _registries.pop(meeting_id, None)


def get_entity_map(meeting_id: str) -> dict[str, str]:
    """Get the current entity map for a meeting."""
    if meeting_id in _registries:
        return _registries[meeting_id].entity_map
    return {}


async def anonymize_text(
    text: str,
    meeting_id: str,
    entity_map: Optional[dict[str, str]] = None,
    detect_json: bool = True,
) -> tuple[str, dict[str, str], list[dict]]:
    """Anonymize PII in text.

    Args:
        text: The text to anonymize.
        meeting_id: Meeting identifier for consistent surrogates.
        entity_map: Optional existing entity map to extend.
        detect_json: Whether to detect and handle JSON blocks specially.

    Returns:
        Tuple of (anonymized_text, updated_entity_map, entities_found).
    """
    if not _presidio_available:
        logger.warning("Presidio not available, returning text unchanged")
        return text, entity_map or {}, []

    registry = get_registry(meeting_id, entity_map)

    # First pass: detect all PERSON entities for name clustering
    person_results = _analyzer.analyze(
        text=text,
        entities=["PERSON"],
        language="en",
    )
    person_results = _filter_uuid_false_positives(text, person_results)
    person_names = [
        text[r.start:r.end]
        for r in person_results
        if r.score >= SURROGATE_THRESHOLD
    ]
    if person_names:
        registry.cluster_names(person_names)

    # Handle JSON blocks specially
    if detect_json:
        parsed, is_json = _try_parse_json_block(text)
        if is_json:
            anonymized_obj = _anonymize_json_values(parsed, registry)
            anonymized_text = json.dumps(anonymized_obj, indent=2, ensure_ascii=False)
            entities_found = _collect_entities_found(text, registry)
            return anonymized_text, registry.entity_map, entities_found

    # Standard text anonymization
    anonymized_text = _anonymize_text_segment(text, registry)
    entities_found = _collect_entities_found(text, registry)

    return anonymized_text, registry.entity_map, entities_found


async def anonymize_texts(
    texts: list[str],
    meeting_id: str,
    entity_map: Optional[dict[str, str]] = None,
    detect_json: bool = True,
) -> tuple[list[str], dict[str, str], list[dict]]:
    """Anonymize PII in multiple texts (batch).

    Uses a shared entity registry so surrogates are consistent across all texts.
    """
    if not _presidio_available:
        return texts, entity_map or {}, []

    registry = get_registry(meeting_id, entity_map)

    # First pass: collect all PERSON entities across all texts for clustering
    all_person_names = []
    for text in texts:
        results = _analyzer.analyze(text=text, entities=["PERSON"], language="en")
        results = _filter_uuid_false_positives(text, results)
        all_person_names.extend(
            text[r.start:r.end] for r in results if r.score >= SURROGATE_THRESHOLD
        )
    if all_person_names:
        registry.cluster_names(all_person_names)

    # Second pass: anonymize each text
    sanitized = []
    all_entities: list[dict] = []
    for text in texts:
        if detect_json:
            parsed, is_json = _try_parse_json_block(text)
            if is_json:
                anon_obj = _anonymize_json_values(parsed, registry)
                sanitized.append(json.dumps(anon_obj, indent=2, ensure_ascii=False))
                all_entities.extend(_collect_entities_found(text, registry))
                continue

        anonymized = _anonymize_text_segment(text, registry)
        sanitized.append(anonymized)
        all_entities.extend(_collect_entities_found(text, registry))

    return sanitized, registry.entity_map, all_entities


def _collect_entities_found(text: str, registry: EntityRegistry) -> list[dict]:
    """Collect a summary of entities found in text."""
    if not _presidio_available:
        return []

    results = _analyzer.analyze(text=text, entities=ALL_ENTITIES, language="en")
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
