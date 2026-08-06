from uuid import uuid4

from websec_observer.domain.enums import ReplayStatus
from websec_observer.domain.models import ParameterOverride, ReplayRun


def test_replay_run_keeps_parameter_identity_and_value_override() -> None:
    request_id = uuid4()
    run = ReplayRun(
        session_id=uuid4(),
        request_id=request_id,
        overrides=(ParameterOverride(location="query", name="page", value="2"),),
    )

    assert run.request_id == request_id
    assert run.status is ReplayStatus.CREATED
    assert run.overrides[0].name == "page"
    assert run.overrides[0].value == "2"
