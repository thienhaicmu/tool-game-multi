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

Protocol control is guarded to local/test hosts by default. For an explicitly
authorized debugging session, the guard can be disabled without removing the
allowlist code:

```powershell
$env:OBSERVATORY_DISABLE_ENV_GUARD="true"
npm start
```

With the guard disabled, Manual Test, Auto Test, and b-Test may target the
currently selected project target outside local/test naming. Scope, live-session
checks, payload validation, and execution auditing remain active. Unset the
variable (or set it to `false`) to restore the default guard.

`npm start` launches the Electron desktop prototype. The target Chromium window and the inspector
are currently functional, but capture persistence/application-service integration is still the next
planned milestone. The Python package remains the authoritative domain, policy, storage, analysis,
and reporting implementation; see `docs/adr/0001-desktop-application-boundary.md`.

Optional licensing is disabled by default. Enable verification with
`OBSERVATORY_LICENSE_ENABLED=true`, then provide `OBSERVATORY_LICENSE_PUBLIC_KEY`
and optionally `OBSERVATORY_LICENSE_FILE`:

```powershell
node tools/license-gen.cjs keygen license-keys
node tools/license-gen.cjs issue license-keys/private.pem license.json LIC-001 "Company A" 2027-12-31T23:59:59Z
```

Keep `private.pem` outside the application and never commit it. The desktop app
only verifies licenses with the public key.
