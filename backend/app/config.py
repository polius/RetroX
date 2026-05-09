from __future__ import annotations

import secrets
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="RETROX_",
        case_sensitive=False,
        extra="ignore",
    )

    data_dir: Path = Path("/data")

    frontend_dir: Path = Path("/app/frontend")
    emulatorjs_dir: Path = Path("/app/docker/emulatorjs")

    admin_username: str = "admin"
    admin_password: str = "admin"

    secret_key: str | None = None

    # Access tokens are short-lived; refresh tokens carry the long-lived
    # "I am still signed in" promise. Compromise of an access token is
    # bounded to access_token_minutes; refresh requires a separate cookie
    # the JS code never reads.
    access_token_minutes: int = 30
    refresh_token_days: int = 30
    pre2fa_seconds: int = 300

    # Per-file upload cap, applied to both .save (SRAM) and .state
    # uploads. SRAM is tiny (<1 MB even for PSX); the cap is sized for
    # state snapshots, which include whole VRAM/audio/CPU state. N64
    # (mupen64plus_next) routinely produces 6-16 MiB states, so 32 MiB
    # gives comfortable headroom while still bounding memory per request.
    max_save_bytes: int = 32 * 1024 * 1024

    host: str = "0.0.0.0"
    port: int = 8080

    @property
    def roms_dir(self) -> Path:
        return self.data_dir / "roms"

    @property
    def covers_dir(self) -> Path:
        return self.data_dir / "covers"

    @property
    def saves_dir(self) -> Path:
        return self.data_dir / "saves"

    @property
    def cores_dir(self) -> Path:
        return self.data_dir / "cores"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "retrox.db"

    @property
    def db_url(self) -> str:
        return f"sqlite:///{self.db_path}"

    def resolve_secret_key(self) -> str:
        if self.secret_key:
            return self.secret_key
        path = self.data_dir / ".secret"
        if path.exists():
            return path.read_text().strip()
        key = secrets.token_urlsafe(48)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key)
        path.chmod(0o600)
        return key

    def lock_secret_key(self) -> None:
        """Resolve the secret once at startup and pin it to the instance.

        Without this every JWT issue/decode could trigger a fresh disk
        write on first call, racing with concurrent requests.
        """
        self.secret_key = self.resolve_secret_key()


settings = Settings()
