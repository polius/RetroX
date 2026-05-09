from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Cookie, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from . import __version__
from .config import settings
from .db import SessionLocal, init_db
from .limiter import limiter
from .models import Emulator, GameMeta, User
from .routers import admin, auth, collections, controller, games, profile, saves
from .routers.auth import ACCESS_COOKIE, REFRESH_COOKIE
from .security import decode_token, hash_password
from .services.library import library

log = logging.getLogger("retrox")


FRONTEND_DIR = settings.frontend_dir
EMULATORJS_DIR = settings.emulatorjs_dir

PAGES = {
    "/login": "login.html",
    "/games": "games.html",
    "/game": "game.html",
    "/play": "play.html",
    "/profile": "profile.html",
    "/link": "link.html",
    "/pair": "pair.html",
    "/admin": "admin.html",
    "/admin/users": "admin.html",
    "/admin/library": "admin.html",
    "/admin/emulators": "admin.html",
    "/admin/collections": "admin.html",
    "/admin/saves": "admin.html",
}


def _bootstrap_admin() -> None:
    """Create the bootstrap admin user when the DB has no users yet."""
    with SessionLocal() as db:
        if db.query(User).count() > 0:
            return
        user = User(
            username=settings.admin_username,
            password=hash_password(settings.admin_password),
            is_admin=True,
            created_at=datetime.now(tz=UTC),
        )
        db.add(user)
        db.commit()
        log.info("Bootstrapped admin user %r", settings.admin_username)


# Per-system defaults. fast_forward_enabled is off where L2/R2 are real
# game inputs (PSX, N64). rewind_enabled is on for cores known to handle
# rewind well without surprise memory blowups (gambatte, mgba).
DEFAULT_EMULATORS = [
    # (name,                system, extensions,                    core,               fast_forward, rewind)
    ("Game Boy",            "gb",   "gb",                          "gambatte",         True,         True),
    ("Game Boy Color",      "gbc",  "gbc,gb",                      "gambatte",         True,         True),
    ("Game Boy Advance",    "gba",  "gba",                         "mgba",             True,         True),
    ("PlayStation",         "psx",  "bin,cue,iso,img,chd,pbp,ecm", "pcsx_rearmed",     False,        False),
    ("Nintendo 64",         "n64",  "n64,z64,v64",                 "mupen64plus_next", False,        False),
]


def _seed_emulators() -> None:
    """Insert default emulator rows when the table is empty."""
    with SessionLocal() as db:
        if db.query(Emulator).count() > 0:
            return
        for name, system, extensions, core, fast_forward, rewind in DEFAULT_EMULATORS:
            db.add(Emulator(
                name=name, system=system, extensions=extensions, core=core,
                fast_forward_enabled=fast_forward, rewind_enabled=rewind,
            ))
        db.commit()
        log.info("Seeded %d default emulators", len(DEFAULT_EMULATORS))


# Bundled with the image alongside the demo ROMs and covers (see
# entrypoint.sh). The path is /app/docker/roms/seed_metadata.json in
# the container; the local dev path resolves to the repo's docker dir.
_DEMO_METADATA_MANIFEST = Path(__file__).resolve().parents[2] / "docker" / "roms" / "seed_metadata.json"


def _seed_demo_metadata() -> None:
    """Apply default metadata for the bundled demo games on first launch.

    Idempotent and never destructive:
      - Skipped for any game_id that isn't present in the scanned library
        (a stale manifest entry is a no-op, not a crash).
      - Library.scan() always creates a "skeleton" meta row containing
        just (game_id, slug). We populate that skeleton with display name
        / description / release date / nicer slug.
      - If the row has any of those user-visible fields already filled in
        (i.e. an admin edited it), we leave it alone — no overwriting
        user data on container restart.
    """
    if not _DEMO_METADATA_MANIFEST.is_file():
        return
    try:
        entries = json.loads(_DEMO_METADATA_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("Couldn't read demo metadata manifest: %s", e)
        return
    if not isinstance(entries, list):
        log.warning("Demo metadata manifest is not a list — skipping")
        return

    seeded = 0
    with SessionLocal() as db:
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            game_id = entry.get("game_id")
            if not game_id or library.index.get(game_id) is None:
                continue  # demo ROM not on disk for this install

            existing = db.query(GameMeta).filter(GameMeta.game_id == game_id).first()
            if existing is None:
                # No row at all — full insert. Shouldn't happen in
                # practice (library.scan() already created a skeleton)
                # but is the right thing to do if it ever does.
                db.add(GameMeta(
                    game_id=game_id,
                    display_name=entry.get("display_name"),
                    description=entry.get("description"),
                    release_date=entry.get("release_date"),
                    slug=entry.get("slug"),
                ))
                seeded += 1
                continue

            # Row exists. If a human ever filled in any user-visible
            # field, leave it alone. Otherwise this is a fresh skeleton
            # waiting for content.
            human_touched = bool(
                existing.display_name or existing.description or existing.release_date
            )
            if human_touched:
                continue
            existing.display_name = entry.get("display_name")
            existing.description = entry.get("description")
            existing.release_date = entry.get("release_date")
            manifest_slug = entry.get("slug")
            if manifest_slug:
                existing.slug = manifest_slug
            seeded += 1
        if seeded:
            db.commit()
            log.info("Seeded metadata for %d demo game(s)", seeded)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    )
    log.info("Bootstrapping data skeleton at %s", settings.data_dir)
    # Pin the JWT secret on the settings object once. Otherwise every
    # token issue/decode call could race to write /data/.secret on first
    # request, and a transient disk error would leak through to /login.
    settings.lock_secret_key()
    init_db()
    _bootstrap_admin()
    _seed_emulators()
    library.bootstrap_skeleton()
    library.scan()
    _seed_demo_metadata()  # depends on library.scan() having populated library.index
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="RetroX",
        version=__version__,
        docs_url="/docs",
        redoc_url=None,
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    # Wire up rate limiting. Routers attach @limiter.limit(...) decorators
    # directly; the handler returns the standard 429 with Retry-After.
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    # Reject obvious cross-origin state-changing requests cheaply, before
    # they reach the per-route rate limiter or auth deps. Sec-Fetch-Site
    # is the primary signal (sent by all currently supported browsers);
    # Origin/Referer is the fallback for older clients and tooling.
    @app.middleware("http")
    async def check_origin(request: Request, call_next):  # noqa: RUF029
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            sec_fetch_site = request.headers.get("sec-fetch-site")
            if sec_fetch_site in {"same-origin", "none"}:
                pass
            else:
                origin = request.headers.get("origin") or request.headers.get("referer")
                host = request.headers.get("host")
                # Compare netloc for equality, not substring — otherwise
                # `evil.tld` containing the legitimate host as a suffix passes.
                origin_netloc = urlparse(origin).netloc.lower() if origin else ""
                if not (origin_netloc and host and origin_netloc == host.lower()):
                    return JSONResponse(
                        {"error": "cross-origin request rejected"}, status_code=403,
                    )
        return await call_next(request)

    app.include_router(auth.router)
    app.include_router(profile.router)
    app.include_router(games.router)
    app.include_router(saves.router)
    app.include_router(admin.router)
    app.include_router(collections.router)
    app.include_router(controller.router)

    if EMULATORJS_DIR.is_dir():
        # Serve cores from /data/cores/ (bundled cores are seeded there on first start)
        @app.get("/emulatorjs/cores/{filename:path}", include_in_schema=False)
        def emulatorjs_core(filename: str) -> FileResponse:
            from fastapi import HTTPException

            core_path = (settings.cores_dir / filename).resolve()
            if core_path.is_file() and str(core_path).startswith(str(settings.cores_dir.resolve())):
                return FileResponse(core_path, headers={"Cache-Control": "public, max-age=86400"})
            raise HTTPException(404, "Core not found.")

        app.mount("/emulatorjs", StaticFiles(directory=EMULATORJS_DIR), name="emulatorjs")
    else:
        log.warning("EmulatorJS directory not found at %s", EMULATORJS_DIR)

    # Static asset folders of the frontend. `fonts/` is part of the
    # self-hosted font bundle referenced by /css/fonts.css.
    for sub in ("css", "js", "images", "fonts"):
        path = FRONTEND_DIR / sub
        if path.is_dir():
            app.mount(f"/{sub}", StaticFiles(directory=path), name=f"frontend-{sub}")

    # `/` is a server-side redirect, not a real page. We pick the
    # destination from the cookie state directly so the browser follows
    # one 302 instead of seeing a flash of logo+spinner from a JS-driven
    # routing gate. /games and /login both validate the session against
    # the DB themselves on their next request — this only needs to be
    # right enough to avoid a wrong first hop.
    @app.get("/", include_in_schema=False)
    def root_redirect(
        access_token: str | None = Cookie(default=None, alias=ACCESS_COOKIE),
        refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
    ) -> RedirectResponse:
        if access_token and decode_token(access_token, "access") is not None:
            return RedirectResponse("/games", status_code=302)
        # Expired access cookie + valid refresh = still effectively signed
        # in. /games will silently refresh on its first API call (api.js
        # handles 401-then-refresh-then-retry transparently).
        if refresh_token and decode_token(refresh_token, "refresh") is not None:
            return RedirectResponse("/games", status_code=302)
        return RedirectResponse("/login", status_code=302)

    # Friendly URLs for the SPA-ish pages — explicit list, no catch-all
    for url, file in PAGES.items():
        page_path = FRONTEND_DIR / file
        app.add_api_route(
            url,
            _make_page_handler(page_path),
            methods=["GET"],
            include_in_schema=False,
        )
        # Also accept the bare ".html" URLs so existing bookmarks keep working
        app.add_api_route(
            f"/{file}",
            _make_page_handler(page_path),
            methods=["GET"],
            include_in_schema=False,
        )

    # Slug-based game page: /game/<slug> serves the same game.html
    app.add_api_route(
        "/game/{slug:path}",
        _make_slug_page_handler(FRONTEND_DIR / "game.html"),
        methods=["GET"],
        include_in_schema=False,
    )

    # Slug-based play page: /play/<slug> serves play.html
    app.add_api_route(
        "/play/{slug:path}",
        _make_slug_page_handler(FRONTEND_DIR / "play.html"),
        methods=["GET"],
        include_in_schema=False,
    )

    @app.get("/favicon.ico", include_in_schema=False)
    def favicon() -> RedirectResponse:
        return RedirectResponse(url="/images/favicon.svg", status_code=301)

    @app.get("/health", include_in_schema=False)
    def health() -> dict:
        # Cheap liveness probe used by Docker HEALTHCHECK and any external
        # uptime monitor. Intentionally does no DB roundtrip — the lifespan
        # has already proved the DB and library scan are healthy by the
        # time the app accepts requests.
        return {"status": "ok"}

    # Serve the branded 404 page for unknown HTML routes; keep API 404s
    # as JSON so clients (the JS SPA, future integrations) get machine-
    # readable errors. Discrimination is by path prefix — anything under
    # /api/ stays JSON, everything else gets the page.
    _not_found_page = FRONTEND_DIR / "404.html"

    @app.exception_handler(404)
    async def not_found_handler(request: Request, exc):  # noqa: ANN001, ARG001
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "Not found."}, status_code=404)
        if _not_found_page.is_file():
            return FileResponse(
                _not_found_page, status_code=404, media_type="text/html",
                headers=_page_headers(_not_found_page),
            )
        return JSONResponse({"detail": "Not found."}, status_code=404)

    return app


# Security headers for HTML pages. Set centrally here so we don't
# duplicate them across every HTML file (the meta-tag versions drifted
# in the past — a strict policy lingered on /games after /game got the
# loose one, silently re-breaking the in-place player whenever the SPA
# router soft-navved through /games first). frame-ancestors is HTTP-
# header-only by spec; X-Frame-Options is its drop-in equivalent.
#
# SHELL_CSP — every page that hosts EmulatorJS, plus every page the SPA
# router can soft-nav INTO a player host from. The browser locks meta-
# CSP at document load and soft-nav doesn't replace the document, so
# the first hard-loaded shell page's policy applies for the session.
_SHELL_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self'; "
    "connect-src 'self' https://cdn.emulatorjs.org blob:; "
    "worker-src 'self' blob:; "
    "media-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)

# STRICT_CSP — hard-nav-only pages (auth, link, 404). They can keep a
# tighter policy because every load is a fresh document — there's no
# soft-nav escape into the player to worry about.
_STRICT_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)

_SHELL_HTML = frozenset({
    "games.html", "game.html", "play.html", "profile.html", "admin.html",
})


def _page_headers(page_path: Path) -> dict[str, str]:
    csp = _SHELL_CSP if page_path.name in _SHELL_HTML else _STRICT_CSP
    return {"X-Frame-Options": "DENY", "Content-Security-Policy": csp}


def _make_page_handler(page_path: Path):
    headers = _page_headers(page_path)
    def _handler() -> FileResponse:
        return FileResponse(page_path, media_type="text/html", headers=headers)
    return _handler


def _make_slug_page_handler(page_path: Path):
    headers = _page_headers(page_path)
    def _handler(slug: str) -> FileResponse:
        return FileResponse(page_path, media_type="text/html", headers=headers)
    return _handler


app = create_app()
