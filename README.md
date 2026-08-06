# Web Security Observatory

Authorized-use, passive-first browser and API security observation. See
`MASTER_IMPLEMENTATION_PLAN.md` for the approved architecture and delivery gates.

Requires Python 3.12+. Install development dependencies with
`python -m pip install -e ".[dev]"`, then run `python -m pytest`,
`python -m ruff check .`, and `python -m mypy websec_observer tests`.

Active validation is disabled by default. Browser capture is delivered by a later approved work
unit.

## Desktop prototype and product architecture

Run the standalone UI with:

```powershell
npm start
```

`npm start` launches the Electron desktop prototype. The target Chromium window and the inspector
are currently functional, but capture persistence/application-service integration is still the next
planned milestone. The Python package remains the authoritative domain, policy, storage, analysis,
and reporting implementation; see `docs/adr/0001-desktop-application-boundary.md`.
