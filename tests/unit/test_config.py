import pytest
from pydantic import ValidationError

from websec_observer.config import ActiveValidationConfig, ProjectConfig


def test_passive_only_is_default() -> None:
    config = ProjectConfig(
        name="Local test",
        base_url="https://staging.example.test",
        allowed_hosts=("staging.example.test",),
    )
    assert config.passive_only is True
    assert config.active_validation.enabled is False


def test_active_validation_requires_dual_opt_in() -> None:
    with pytest.raises(ValidationError, match="authorized=true"):
        ActiveValidationConfig(enabled=True)


def test_passive_mode_rejects_active_validation() -> None:
    with pytest.raises(ValidationError, match="passive_only"):
        ProjectConfig(
            name="Invalid",
            base_url="https://example.test",
            allowed_hosts=("example.test",),
            active_validation=ActiveValidationConfig(enabled=True, authorized=True),
        )


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "TRACE"])
def test_mutating_methods_are_rejected(method: str) -> None:
    with pytest.raises(ValidationError, match="forbidden"):
        ActiveValidationConfig(allowed_methods=(method,))


def test_schema_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError, match="unknown"):
        ProjectConfig.model_validate(
            {
                "name": "Demo",
                "base_url": "https://example.test",
                "allowed_hosts": ["example.test"],
                "unknown": True,
            }
        )
