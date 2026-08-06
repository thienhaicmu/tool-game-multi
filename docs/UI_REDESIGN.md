# Observatory desktop UI redesign

## Product posture

The desktop app is a debugging workspace, not a raw security-console form.
Chromium is the interaction surface; Observatory is the session, request and
replay workspace.

## Main shell

```text
┌ Project / session ┬ Request explorer ┬ Replace & replay workspace ┐
│ projects          │ filters          │ selected request             │
│ browser profile   │ request rows     │ parameter cards              │
│ session status    │ multi-select     │ response / diff / history    │
└───────────────────┴──────────────────┴──────────────────────────────┘
```

## Interaction rules

- Open Chromium is a primary action in the session header.
- Scope is configured in project settings, not kept in the main toolbar.
- Request rows always expose a visible checkbox and selection count.
- Clicking a row opens the workspace; selecting a checkbox does not navigate
  away from the list.
- The replace editor exposes parameter values only by default. Method, path,
  parameter names and headers are read-only until an advanced action is
  explicitly enabled.
- Replay always shows a compact before/after diff and result state.
- Raw credentials, cookies and authorization values never appear in the main
  UI.

## Navigation

- Overview
- Live requests
- Saved sessions
- Replay history
- Findings
- Project settings

The current prototype remains available during migration, but new UI features
must target this information architecture rather than adding controls to the
legacy toolbar.
