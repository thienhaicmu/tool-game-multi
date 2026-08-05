from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence

from websec_observer.analysis.types import AnalysisContext, PassiveRule, TransactionView
from websec_observer.domain.models import FindingDraft

logger = logging.getLogger(__name__)


class RuleRegistry:
    def __init__(self, rules: Iterable[PassiveRule] = ()) -> None:
        self._rules: dict[str, PassiveRule] = {}
        for rule in rules:
            self.register(rule)

    def register(self, rule: PassiveRule) -> None:
        if not rule.rule_id or rule.rule_id in self._rules:
            raise ValueError(f"duplicate or empty rule id: {rule.rule_id!r}")
        self._rules[rule.rule_id] = rule

    def get(self, rule_id: str) -> PassiveRule:
        return self._rules[rule_id]

    def list(self) -> tuple[PassiveRule, ...]:
        return tuple(self._rules[key] for key in sorted(self._rules))

    def enabled(self, rule_ids: frozenset[str] | None = None) -> tuple[PassiveRule, ...]:
        if rule_ids is None:
            return self.list()
        unknown = rule_ids - self._rules.keys()
        if unknown:
            raise ValueError(f"unknown rule ids: {sorted(unknown)}")
        return tuple(self._rules[key] for key in sorted(rule_ids))


class RuleEngine:
    def __init__(self, registry: RuleRegistry) -> None:
        self._registry = registry

    def analyze(
        self, transaction: TransactionView, context: AnalysisContext, enabled_rule_ids: frozenset[str] | None = None
    ) -> tuple[FindingDraft, ...]:
        findings: list[FindingDraft] = []
        for rule in self._registry.enabled(enabled_rule_ids):
            try:
                findings.extend(rule.analyze(transaction, context))
            except Exception:
                logger.exception(
                    "passive rule failed",
                    extra={"event": "rule_failed", "rule_id": rule.rule_id},
                )
        return tuple(findings)


def default_registry() -> RuleRegistry:
    from websec_observer.analysis.rules.cookies import CookieSecurityRule
    from websec_observer.analysis.rules.security_headers import SecurityHeadersRule
    from websec_observer.analysis.rules.sensitive_response import SensitiveResponseRule
    from websec_observer.analysis.rules.token_url import TokenInUrlRule
    from websec_observer.analysis.rules.transport_security import (
        MissingHstsRule,
        PlaintextTransportRule,
    )

    return RuleRegistry(
        (
            PlaintextTransportRule(),
            MissingHstsRule(),
            SecurityHeadersRule(),
            CookieSecurityRule(),
            TokenInUrlRule(),
            SensitiveResponseRule(),
        )
    )
