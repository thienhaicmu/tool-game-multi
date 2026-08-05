# Database migrations

Apply migrations with:

```powershell
python -m alembic upgrade head
```

The default URL in `alembic.ini` is for local development only. Application code should supply a
validated SQLite URL or connection. Never place credentials or captured secrets in migration
configuration.

Downgrades are intended for local development and automated migration verification. Back up
material session databases before an operator-approved downgrade.
