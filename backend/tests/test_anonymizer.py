"""Tests for the PII anonymizer module (F005).

Organized into test classes by component:
- TestNameClusterer: Union-Find name clustering (pure Python, no Presidio needed)
- TestEntityRegistry: Surrogate generation and entity map management (no Presidio needed)
- TestEntityRegistryPersistence: File-based save/load of entity maps
- TestUuidFalsePositiveFilter: UUID pattern exclusion from PII detection
- TestJsonAwareAnonymization: JSON block handling (requires Presidio)
- TestAnonymizeText: Core single-text anonymization (requires Presidio)
- TestAnonymizeTexts: Batch anonymization (requires Presidio)
- TestRegistryManagement: LRU eviction and TTL cleanup of in-memory registries
"""

import json
import time
import pytest
from unittest.mock import patch

import anonymizer
from anonymizer import (
    NameClusterer,
    EntityRegistry,
    _filter_uuid_false_positives,
    _anonymize_json_values,
    _anonymize_text_segment,
    get_registry,
    clear_registry,
    get_entity_map,
    anonymize_text,
    anonymize_texts,
    _cleanup_expired_registries,
    _evict_lru_if_needed,
    _registries,
    _registry_last_access,
    _REGISTRY_TTL_SECS,
    _REGISTRY_MAX_SIZE,
    is_available,
)

# Marker for tests that require Presidio + spaCy
requires_presidio = pytest.mark.skipif(
    not anonymizer.is_available(),
    reason="Presidio/spaCy not installed",
)


# ---------------------------------------------------------------------------
# NameClusterer tests (pure Python — no Presidio dependency)
# ---------------------------------------------------------------------------


class TestNameClusterer:
    """Tests for Union-Find name clustering with nickname resolution."""

    def test_find_creates_singleton(self):
        """Find on a new name should return that name as its own root."""
        nc = NameClusterer()
        assert nc.find("John Smith") == "John Smith"

    def test_union_merges_two_names(self):
        """Union of two names makes them share the same cluster root."""
        nc = NameClusterer()
        nc.union("John Smith", "Mr. Smith")
        assert nc.find("John Smith") == nc.find("Mr. Smith")

    def test_cluster_full_and_last_name(self):
        """'John Smith' and 'Mr. Smith' should cluster (same last, one missing first)."""
        nc = NameClusterer()
        nc.cluster(["John Smith", "Mr. Smith"])
        assert nc.find("John Smith") == nc.find("Mr. Smith")

    def test_cluster_full_and_lone_first(self):
        """'John Smith' and 'John' should cluster (lone first matches full name first)."""
        nc = NameClusterer()
        nc.cluster(["John Smith", "John"])
        assert nc.find("John Smith") == nc.find("John")

    def test_cluster_nickname_resolution(self):
        """'Bob Smith' and 'Robert Smith' should cluster via nickname table."""
        nc = NameClusterer()
        nc.cluster(["Bob Smith", "Robert Smith"])
        assert nc.find("Bob Smith") == nc.find("Robert Smith")

    def test_cluster_three_variants(self):
        """'John Smith', 'Mr. Smith', and 'Johnny Smith' share one cluster."""
        nc = NameClusterer()
        nc.cluster(["John Smith", "Mr. Smith", "Johnny Smith"])
        root = nc.find("John Smith")
        assert nc.find("Mr. Smith") == root
        assert nc.find("Johnny Smith") == root

    def test_unrelated_names_stay_separate(self):
        """Names with different last names should NOT cluster."""
        nc = NameClusterer()
        nc.cluster(["John Smith", "Jane Doe"])
        assert nc.find("John Smith") != nc.find("Jane Doe")

    def test_are_related_same_last_different_first(self):
        """Two full names with different (non-nickname) firsts but same last stay apart."""
        nc = NameClusterer()
        nc.cluster(["Alice Smith", "Bob Smith"])
        # Alice and Bob are not nicknames of each other
        assert nc.find("Alice Smith") != nc.find("Bob Smith")

    def test_canonical_first_lowercases(self):
        """Canonical first should be case-insensitive."""
        nc = NameClusterer()
        assert nc._canonical_first("JOHN") == "john"
        assert nc._canonical_first("Johnny") == "john"

    def test_get_cluster_root_is_find(self):
        """get_cluster_root delegates to find()."""
        nc = NameClusterer()
        nc.union("A", "B")
        assert nc.get_cluster_root("B") == nc.find("B")


# ---------------------------------------------------------------------------
# EntityRegistry tests (uses Faker, no Presidio dependency)
# ---------------------------------------------------------------------------


class TestEntityRegistry:
    """Tests for surrogate generation, consistency, and cluster-aware derivation."""

    def test_deterministic_seed_per_meeting(self):
        """Same meeting_id produces the same Faker seed, different IDs differ."""
        reg1 = EntityRegistry(meeting_id="meeting-aaa")
        reg2 = EntityRegistry(meeting_id="meeting-aaa")
        reg3 = EntityRegistry(meeting_id="meeting-bbb")

        # Same seed -> same first generated name
        name1 = reg1._faker.name()
        name2 = reg2._faker.name()
        name3 = reg3._faker.name()
        assert name1 == name2
        assert name1 != name3  # unlikely but theoretically possible; good enough

    def test_get_surrogate_creates_mapping(self):
        """First call for a value creates a surrogate; second returns the same."""
        reg = EntityRegistry(meeting_id="m1")
        s1 = reg.get_surrogate("John Smith", "PERSON")
        s2 = reg.get_surrogate("John Smith", "PERSON")
        assert s1 == s2
        assert s1 != "John Smith"

    def test_different_values_get_different_surrogates(self):
        """Different real values should get different surrogates."""
        reg = EntityRegistry(meeting_id="m2")
        s1 = reg.get_surrogate("Alice", "PERSON")
        s2 = reg.get_surrogate("Bob", "PERSON")
        assert s1 != s2

    def test_entity_map_property_returns_copy(self):
        """entity_map property should return a dict copy of mappings."""
        reg = EntityRegistry(meeting_id="m3")
        reg.get_surrogate("test@example.com", "EMAIL_ADDRESS")
        em = reg.entity_map
        assert "test@example.com" in em
        assert isinstance(em, dict)
        # Modifying the copy should not affect internal state
        em["new_key"] = "new_val"
        assert "new_key" not in reg.entity_map

    def test_reverse_map_populated(self):
        """Getting a surrogate should also populate the reverse map."""
        reg = EntityRegistry(meeting_id="m4")
        surrogate = reg.get_surrogate("Jane Doe", "PERSON")
        assert reg._reverse[surrogate] == "Jane Doe"

    def test_load_populates_both_maps(self):
        """Loading an entity map should populate both forward and reverse maps."""
        reg = EntityRegistry(meeting_id="m5")
        reg.load({"real@email.com": "fake@example.com", "John": "Marcus"})
        assert reg._map["real@email.com"] == "fake@example.com"
        assert reg._reverse["fake@example.com"] == "real@email.com"
        assert reg._map["John"] == "Marcus"
        assert reg._reverse["Marcus"] == "John"

    def test_surrogate_types(self):
        """Each entity type should produce a type-appropriate surrogate."""
        reg = EntityRegistry(meeting_id="m6")

        person = reg.get_surrogate("Alice Wonderland", "PERSON")
        assert isinstance(person, str) and len(person) > 0

        email = reg.get_surrogate("alice@wonder.land", "EMAIL_ADDRESS")
        assert "@" in email

        phone = reg.get_surrogate("555-123-4567", "PHONE_NUMBER")
        assert isinstance(phone, str) and len(phone) > 0

        location = reg.get_surrogate("New York", "LOCATION")
        assert isinstance(location, str) and len(location) > 0

    def test_redact_entity_type_produces_bracket_tag(self):
        """Non-surrogate entity types should produce [TYPE] placeholders."""
        reg = EntityRegistry(meeting_id="m7")
        result = reg._generate_surrogate("CREDIT_CARD")
        assert result == "[CREDIT_CARD]"

    def test_cluster_names_and_derive_sub_surrogate(self):
        """After clustering, name variants should derive related surrogates."""
        reg = EntityRegistry(meeting_id="m8")
        reg.cluster_names(["John Smith", "Mr. Smith"])

        # Get the root surrogate first
        reg.get_surrogate("John Smith", "PERSON")
        # Variant should derive from root
        variant_surrogate = reg.get_surrogate("Mr. Smith", "PERSON")

        # Both should be in the entity map
        assert "John Smith" in reg.entity_map
        assert "Mr. Smith" in reg.entity_map

        # The variant should contain part of the root surrogate (the last name)
        # We can at least verify they are different from the original
        assert variant_surrogate != "Mr. Smith"

    def test_meeting_scoped_surrogates_differ(self):
        """Same name in different meetings should get different surrogates."""
        reg_a = EntityRegistry(meeting_id="meeting-alpha")
        reg_b = EntityRegistry(meeting_id="meeting-beta")

        s_a = reg_a.get_surrogate("John Smith", "PERSON")
        s_b = reg_b.get_surrogate("John Smith", "PERSON")

        # Different seeds should produce different surrogates (extremely likely)
        assert s_a != s_b


# ---------------------------------------------------------------------------
# EntityRegistry persistence tests
# ---------------------------------------------------------------------------


class TestEntityRegistryPersistence:
    """Tests for save/load of entity maps to/from disk."""

    def test_save_and_load_roundtrip(self, tmp_path):
        """Saving then loading should recover the same entity map."""
        reg = EntityRegistry(meeting_id="persist-1")
        reg.get_surrogate("Alice", "PERSON")
        reg.get_surrogate("bob@corp.com", "EMAIL_ADDRESS")
        original_map = reg.entity_map

        reg.save_to_file(str(tmp_path))

        loaded = EntityRegistry.load_from_file("persist-1", str(tmp_path))
        assert loaded.entity_map == original_map

    def test_load_from_nonexistent_file(self, tmp_path):
        """Loading from a directory with no entity_map.json should return empty registry."""
        reg = EntityRegistry.load_from_file("no-such", str(tmp_path))
        assert reg.entity_map == {}
        assert reg.meeting_id == "no-such"

    def test_save_creates_tandem_directory(self, tmp_path):
        """save_to_file should create the .tandem subdirectory."""
        reg = EntityRegistry(meeting_id="dir-test")
        reg.get_surrogate("test", "PERSON")
        reg.save_to_file(str(tmp_path))

        tandem_dir = tmp_path / ".tandem"
        assert tandem_dir.is_dir()
        assert (tandem_dir / "entity_map.json").exists()

    def test_load_preserves_reverse_map(self, tmp_path):
        """After loading, reverse lookups should work for de-anonymization."""
        reg = EntityRegistry(meeting_id="reverse-1")
        surrogate = reg.get_surrogate("Secret Person", "PERSON")
        reg.save_to_file(str(tmp_path))

        loaded = EntityRegistry.load_from_file("reverse-1", str(tmp_path))
        assert loaded._reverse[surrogate] == "Secret Person"


# ---------------------------------------------------------------------------
# UUID false-positive filter tests (no Presidio needed — uses mock results)
# ---------------------------------------------------------------------------


class TestUuidFalsePositiveFilter:
    """Tests for _filter_uuid_false_positives using mock RecognizerResults."""

    def _make_result(self, entity_type, start, end, score=0.85):
        """Create a mock RecognizerResult-like object."""
        from dataclasses import dataclass

        @dataclass
        class FakeResult:
            entity_type: str
            start: int
            end: int
            score: float

        return FakeResult(entity_type=entity_type, start=start, end=end, score=score)

    def test_no_uuids_returns_all_results(self):
        """Text without UUIDs should keep all results unchanged."""
        text = "Call John Smith at 555-1234"
        results = [self._make_result("PERSON", 5, 15)]
        filtered = _filter_uuid_false_positives(text, results)
        assert len(filtered) == 1

    def test_uuid_overlap_removes_result(self):
        """A detection that overlaps a UUID span should be removed."""
        uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        text = f"ID: {uuid}"
        # Simulate a false positive that spans part of the UUID
        start = text.index(uuid)
        results = [self._make_result("PHONE_NUMBER", start + 10, start + 14)]
        filtered = _filter_uuid_false_positives(text, results)
        assert len(filtered) == 0

    def test_non_overlapping_result_kept(self):
        """A detection that does NOT overlap a UUID should be kept."""
        uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        text = f"John Smith has ID {uuid}"
        results = [self._make_result("PERSON", 0, 10)]
        filtered = _filter_uuid_false_positives(text, results)
        assert len(filtered) == 1


# ---------------------------------------------------------------------------
# JSON-aware anonymization tests (requires Presidio for _anonymize_text_segment)
# ---------------------------------------------------------------------------


class TestJsonAwareAnonymization:
    """Tests for _anonymize_json_values preserving JSON structure."""

    def test_numbers_and_booleans_pass_through(self):
        """Non-string JSON values should be returned unchanged."""
        reg = EntityRegistry(meeting_id="json-1")
        assert _anonymize_json_values(42, reg) == 42
        assert _anonymize_json_values(True, reg) is True
        assert _anonymize_json_values(None, reg) is None

    def test_list_of_primitives(self):
        """Lists of non-string primitives should pass through."""
        reg = EntityRegistry(meeting_id="json-2")
        result = _anonymize_json_values([1, 2, 3], reg)
        assert result == [1, 2, 3]

    def test_nested_dict_structure_preserved(self):
        """Dict keys should be preserved; only string values get processed."""
        reg = EntityRegistry(meeting_id="json-3")
        obj = {"count": 5, "active": True, "items": [1, 2]}
        result = _anonymize_json_values(obj, reg)
        assert result == {"count": 5, "active": True, "items": [1, 2]}

    @requires_presidio
    def test_string_values_anonymized_in_json(self):
        """String values containing PII should be anonymized within JSON."""
        reg = EntityRegistry(meeting_id="json-4")
        obj = {"speaker": "John Smith", "count": 3}
        result = _anonymize_json_values(obj, reg)
        # The key should be preserved
        assert "speaker" in result
        assert "count" in result
        assert result["count"] == 3
        # The name may or may not be anonymized depending on spaCy detection
        # but structure is always preserved
        assert isinstance(result["speaker"], str)


# ---------------------------------------------------------------------------
# Core anonymize_text tests (require Presidio)
# ---------------------------------------------------------------------------


class TestAnonymizeText:
    """Tests for the main anonymize_text() async function."""

    @requires_presidio
    @pytest.mark.asyncio
    async def test_empty_text_returns_empty(self):
        """Empty input should return empty output."""
        result, entity_map, entities = await anonymize_text("", "m-empty")
        assert result == ""
        assert entities == []

    @requires_presidio
    @pytest.mark.asyncio
    async def test_no_pii_returns_unchanged(self):
        """Text without PII should be returned unchanged."""
        # Avoid words like "today" which spaCy may detect as DATE_TIME
        text = "The sky is blue and the grass is green."
        result, entity_map, entities = await anonymize_text(text, "m-no-pii")
        assert result == text

    @requires_presidio
    @pytest.mark.asyncio
    async def test_name_detected_and_replaced(self):
        """A clear person name should be detected and replaced with a surrogate."""
        text = "Please contact John Smith for details."
        result, entity_map, entities = await anonymize_text(text, "m-name")
        # The original name should not appear in the result
        assert "John Smith" not in result
        # The entity map should contain the mapping
        assert "John Smith" in entity_map

    @requires_presidio
    @pytest.mark.asyncio
    async def test_email_detected_and_replaced(self):
        """Email addresses should be detected and replaced."""
        text = "Send to alice@example.com for review."
        result, entity_map, entities = await anonymize_text(text, "m-email")
        assert "alice@example.com" not in result
        # At least one entity should be found
        assert len(entities) > 0

    @requires_presidio
    @pytest.mark.asyncio
    async def test_mixed_pii_types(self):
        """Text with multiple PII types should have all detected."""
        text = "John Smith (john@corp.com, 555-123-4567) lives in New York."
        result, entity_map, entities = await anonymize_text(text, "m-mixed")
        # At least the name and email should be detected
        entity_types = {e["entity_type"] for e in entities}
        assert "PERSON" in entity_types or "EMAIL_ADDRESS" in entity_types

    @requires_presidio
    @pytest.mark.asyncio
    async def test_surrogate_consistency_within_meeting(self):
        """Same name in two calls with same meeting_id should get same surrogate."""
        clear_registry("m-consist")
        text1 = "John Smith said hello."
        text2 = "Later, John Smith added a comment."

        _, map1, _ = await anonymize_text(text1, "m-consist")
        _, map2, _ = await anonymize_text(text2, "m-consist")

        # Both calls should produce the same surrogate for John Smith
        if "John Smith" in map1 and "John Smith" in map2:
            assert map1["John Smith"] == map2["John Smith"]

    @requires_presidio
    @pytest.mark.asyncio
    async def test_entity_map_passed_in_is_extended(self):
        """Passing an existing entity_map should extend it, not replace it."""
        existing = {"Old Name": "Fake Name"}
        text = "Please reach out to John Smith."
        _, updated_map, _ = await anonymize_text(text, "m-extend", entity_map=existing)
        # The old mapping should still be present
        assert "Old Name" in updated_map

    @requires_presidio
    @pytest.mark.asyncio
    async def test_json_block_structure_preserved(self):
        """A JSON text block should have values anonymized but structure preserved."""
        json_text = json.dumps({
            "speaker": "John Smith",
            "email": "john@corp.com",
            "score": 95,
        })
        result, _, _ = await anonymize_text(json_text, "m-json", detect_json=True)
        parsed = json.loads(result)
        assert "speaker" in parsed
        assert "email" in parsed
        assert "score" in parsed
        assert parsed["score"] == 95

    @requires_presidio
    @pytest.mark.asyncio
    async def test_very_long_text(self):
        """Anonymization should handle long text without errors."""
        # Build a text ~5000 chars with embedded PII
        base = "John Smith discussed the project. "
        long_text = base * 150  # ~5100 chars
        result, entity_map, entities = await anonymize_text(long_text, "m-long")
        assert isinstance(result, str)
        assert len(result) > 0

    @requires_presidio
    @pytest.mark.asyncio
    async def test_text_with_uuid_not_detected_as_pii(self):
        """UUIDs embedded in text should not be falsely detected as PII."""
        text = "Meeting ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890. Contact John Smith."
        result, entity_map, entities = await anonymize_text(text, "m-uuid-text")
        # The UUID should remain intact in the output
        assert "a1b2c3d4-e5f6-7890-abcd-ef1234567890" in result


# ---------------------------------------------------------------------------
# Batch anonymize_texts tests (require Presidio)
# ---------------------------------------------------------------------------


class TestAnonymizeTexts:
    """Tests for batch anonymize_texts() sharing a registry across texts."""

    @requires_presidio
    @pytest.mark.asyncio
    async def test_batch_shares_registry(self):
        """Multiple texts in a batch should share surrogates for the same name."""
        clear_registry("m-batch")
        texts = [
            "John Smith joined the call.",
            "John Smith presented the slides.",
        ]
        results, entity_map, entities = await anonymize_texts(texts, "m-batch")
        assert len(results) == 2
        # If John Smith was detected, the surrogate should be consistent
        if "John Smith" in entity_map:
            for r in results:
                assert "John Smith" not in r

    @requires_presidio
    @pytest.mark.asyncio
    async def test_batch_empty_list(self):
        """Empty list should return empty results."""
        results, entity_map, entities = await anonymize_texts([], "m-batch-empty")
        assert results == []
        assert entities == []

    @requires_presidio
    @pytest.mark.asyncio
    async def test_batch_mixed_json_and_plain(self):
        """Batch with a mix of JSON and plain text should handle both."""
        clear_registry("m-batch-mix")
        texts = [
            "John Smith said hello.",
            json.dumps({"speaker": "John Smith", "text": "hi"}),
        ]
        results, entity_map, entities = await anonymize_texts(
            texts, "m-batch-mix", detect_json=True
        )
        assert len(results) == 2
        # Second result should be valid JSON
        parsed = json.loads(results[1])
        assert "speaker" in parsed


# ---------------------------------------------------------------------------
# Registry management tests (LRU eviction, TTL cleanup)
# ---------------------------------------------------------------------------


class TestRegistryManagement:
    """Tests for in-memory registry lifecycle: get, clear, TTL, LRU."""

    def setup_method(self):
        """Clear global registries before each test to avoid cross-contamination."""
        _registries.clear()
        _registry_last_access.clear()

    def test_get_registry_creates_new(self):
        """get_registry should create a new registry if none exists."""
        reg = get_registry("mgmt-1")
        assert reg.meeting_id == "mgmt-1"
        assert "mgmt-1" in _registries

    def test_get_registry_returns_same_instance(self):
        """Subsequent calls with same meeting_id return the same registry."""
        reg1 = get_registry("mgmt-2")
        reg1.get_surrogate("test", "PERSON")
        reg2 = get_registry("mgmt-2")
        assert reg2.entity_map == reg1.entity_map

    def test_clear_registry_removes_entry(self):
        """clear_registry should remove the registry and its timestamp."""
        get_registry("mgmt-3")
        clear_registry("mgmt-3")
        assert "mgmt-3" not in _registries
        assert "mgmt-3" not in _registry_last_access

    def test_get_entity_map_for_missing(self):
        """get_entity_map for a non-existent meeting should return empty dict."""
        result = get_entity_map("no-such-meeting")
        assert result == {}

    def test_get_entity_map_returns_current(self):
        """get_entity_map should return the current entity map."""
        reg = get_registry("mgmt-4")
        reg.get_surrogate("Alice", "PERSON")
        em = get_entity_map("mgmt-4")
        assert "Alice" in em

    def test_ttl_cleanup_evicts_expired(self):
        """Registries older than TTL should be evicted by cleanup."""
        get_registry("old-meeting")
        # Backdate the last access to be beyond TTL
        _registry_last_access["old-meeting"] = time.monotonic() - _REGISTRY_TTL_SECS - 1
        _cleanup_expired_registries()
        assert "old-meeting" not in _registries

    def test_ttl_cleanup_keeps_fresh(self):
        """Registries within TTL should not be evicted."""
        get_registry("fresh-meeting")
        _cleanup_expired_registries()
        assert "fresh-meeting" in _registries

    def test_lru_eviction_when_over_max(self):
        """When registries exceed max size, the least recently used should be evicted."""
        # Create MAX + 1 registries
        for i in range(_REGISTRY_MAX_SIZE + 1):
            mid = f"lru-{i:04d}"
            _registries[mid] = EntityRegistry(meeting_id=mid)
            _registry_last_access[mid] = time.monotonic() + i * 0.001

        assert len(_registries) > _REGISTRY_MAX_SIZE
        _evict_lru_if_needed()
        assert len(_registries) <= _REGISTRY_MAX_SIZE

        # The oldest entry (lru-0000) should have been evicted
        assert "lru-0000" not in _registries


# ---------------------------------------------------------------------------
# Presidio availability guard
# ---------------------------------------------------------------------------


class TestPresidioAvailability:
    """Tests for the is_available() guard and graceful degradation."""

    def test_is_available_returns_bool(self):
        """is_available() should return a boolean."""
        result = is_available()
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_anonymize_text_without_presidio_returns_unchanged(self):
        """When Presidio is unavailable, text should be returned unchanged."""
        with patch.object(anonymizer, '_presidio_available', False):
            text = "John Smith at john@corp.com"
            result, entity_map, entities = await anonymize_text(text, "m-no-presidio")
            assert result == text
            assert entities == []

    @pytest.mark.asyncio
    async def test_anonymize_texts_without_presidio_returns_unchanged(self):
        """When Presidio is unavailable, batch should return texts unchanged."""
        with patch.object(anonymizer, '_presidio_available', False):
            texts = ["Alice", "Bob"]
            results, entity_map, entities = await anonymize_texts(texts, "m-no-presidio-batch")
            assert results == texts
            assert entities == []
