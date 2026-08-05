# Web Security Observatory

Authorized-use, passive-first browser and API security observation. See
`MASTER_IMPLEMENTATION_PLAN.md` for the approved architecture and delivery gates.

Requires Python 3.12+. Install development dependencies with
`python -m pip install -e ".[dev]"`, then run `python -m pytest`,
`python -m ruff check .`, and `python -m mypy websec_observer tests`.

Active validation is disabled by default. Browser capture is delivered by a later approved work
unit.

## UI demo

Run the standalone UI with:

```powershell
npm start
```

Then open `http://127.0.0.1:5173`. It includes Overview, Live Network, Request Detail, Findings,
Actions, and Scope & policy views with safe demo data. The frontend is independent of Playwright and
ready to connect to the FastAPI/SSE API in the next integration work unit.
