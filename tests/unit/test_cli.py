from typer.testing import CliRunner

from websec_observer.cli.main import app


def test_cli_help_and_rules_commands() -> None:
    runner = CliRunner()
    help_result = runner.invoke(app, ["--help"])
    assert help_result.exit_code == 0
    assert "Authorized-use" in help_result.stdout
    rules_result = runner.invoke(app, ["rules"])
    assert rules_result.exit_code == 0
    assert "auth.token_in_url" in rules_result.stdout
