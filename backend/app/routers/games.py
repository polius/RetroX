from __future__ import annotations

import mimetypes
import secrets
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from ..config import settings
from ..deps import current_user, get_db
from ..models import Emulator, Favorite, GameMeta, GamePlayStat, SaveSlot, User
from ..models.schemas import (
    GameDetail,
    GameListResponse,
    GameSummary,
    PlaytimePingRequest,
    SlotSummary,
)
from ..services.library import library
from ..services.saves import (
    MAX_SLOT,
    slot_save_path,
    slot_state_path,
)
from ..services.slugs import resolve_slug


def _favorite_ids(db: Session, user_id: int) -> set[str]:
    rows = db.query(Favorite.game_id).filter(Favorite.user_id == user_id).all()
    return {r[0] for r in rows}


def _play_stats(db: Session, user_id: int, game_ids: list[str]) -> dict[str, GamePlayStat]:
    """Map game_id -> GamePlayStat for the given user."""
    if not game_ids:
        return {}
    rows = (
        db.query(GamePlayStat)
        .filter(GamePlayStat.user_id == user_id, GamePlayStat.game_id.in_(game_ids))
        .all()
    )
    return {r.game_id: r for r in rows}


def _slugs(db: Session, game_ids: list[str]) -> dict[str, str]:
    """Map game_id -> slug."""
    if not game_ids:
        return {}
    rows = db.query(GameMeta.game_id, GameMeta.slug).filter(
        GameMeta.game_id.in_(game_ids), GameMeta.slug.isnot(None)
    ).all()
    return {r[0]: r[1] for r in rows}


router = APIRouter(prefix="/api/games", tags=["games"])


def _default_cover() -> Path:
    return settings.frontend_dir / "images" / "default-cover.svg"


def _summary(
    g, *,
    name: str,
    slug: str,
    favs: set[str],
    stats: dict[str, GamePlayStat],
) -> GameSummary:
    stat = stats.get(g.id)
    return GameSummary(
        id=g.id,
        slug=slug,
        name=name,
        system=g.system,
        disks=len(g.disks),
        has_cover=g.cover_path is not None,
        is_favorite=g.id in favs,
        playtime_seconds=stat.playtime_seconds if stat else 0,
        last_played_at=stat.last_played_at if stat else None,
        added_at=g.added_at,
    )


@router.get("/systems")
def list_systems(
    _: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    """Return all emulators with game counts for the sidebar."""
    emulators = db.query(Emulator).order_by(Emulator.name).all()
    all_games = library.index.search(None)
    counts: dict[str, int] = {}
    for g in all_games:
        counts[g.system] = counts.get(g.system, 0) + 1
    return [
        {"system": e.system, "name": e.name, "count": counts.get(e.system, 0)}
        for e in emulators
    ]


@router.get("/recent", response_model=list[GameSummary])
def recent_games(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[GameSummary]:
    """Games the current user has actually played, most recent first."""
    rows = (
        db.query(GamePlayStat)
        .filter(GamePlayStat.user_id == user.id)
        .order_by(GamePlayStat.last_played_at.desc())
        .limit(8)
        .all()
    )
    if not rows:
        return []
    game_ids = [r.game_id for r in rows]
    stats = {r.game_id: r for r in rows}
    favs = _favorite_ids(db, user.id)
    names: dict[str, str] = {}
    slug_map: dict[str, str] = {}
    for m in db.query(GameMeta).filter(GameMeta.game_id.in_(game_ids)).all():
        if m.display_name:
            names[m.game_id] = m.display_name
        if m.slug:
            slug_map[m.game_id] = m.slug
    out: list[GameSummary] = []
    for r in rows:
        game = library.index.get(r.game_id)
        if game is None:
            continue
        out.append(_summary(
            game,
            name=names.get(game.id, game.name),
            slug=slug_map.get(game.id, game.id),
            favs=favs,
            stats=stats,
        ))
    return out


@router.get("/favorites", response_model=list[GameSummary])
def favorite_games(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[GameSummary]:
    favs = _favorite_ids(db, user.id)
    if not favs:
        return []
    fav_list = list(favs)
    names: dict[str, str] = {}
    slug_map: dict[str, str] = {}
    for m in db.query(GameMeta).filter(GameMeta.game_id.in_(fav_list)).all():
        if m.display_name:
            names[m.game_id] = m.display_name
        if m.slug:
            slug_map[m.game_id] = m.slug
    stats = _play_stats(db, user.id, fav_list)
    out: list[GameSummary] = []
    for game_id in fav_list:
        game = library.index.get(game_id)
        if game is None:
            continue
        out.append(_summary(
            game,
            name=names.get(game.id, game.name),
            slug=slug_map.get(game.id, game.id),
            favs=favs,
            stats=stats,
        ))
    out.sort(key=lambda g: g.name.lower())
    return out


@router.get("/random", response_model=GameSummary)
def random_game(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> GameSummary:
    games = library.index.search(None)
    if not games:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No games in library.")
    g = secrets.choice(games)
    favs = _favorite_ids(db, user.id)
    name = g.name
    meta = db.query(GameMeta).filter(GameMeta.game_id == g.id).first()
    if meta and meta.display_name:
        name = meta.display_name
    slug = meta.slug if meta and meta.slug else g.id
    stats = _play_stats(db, user.id, [g.id])
    return _summary(g, name=name, slug=slug, favs=favs, stats=stats)


@router.get("", response_model=GameListResponse)
def list_games(
    q: str | None = Query(default=None, max_length=128),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=48, ge=1, le=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> GameListResponse:
    games = library.index.search(q)
    total = len(games)
    start = (page - 1) * page_size
    chunk = games[start : start + page_size]
    names: dict[str, str] = {}
    slug_map: dict[str, str] = {}
    favs = _favorite_ids(db, user.id) if chunk else set()
    chunk_ids = [g.id for g in chunk]
    if chunk_ids:
        for m in db.query(GameMeta).filter(GameMeta.game_id.in_(chunk_ids)).all():
            if m.display_name:
                names[m.game_id] = m.display_name
            if m.slug:
                slug_map[m.game_id] = m.slug
    stats = _play_stats(db, user.id, chunk_ids)
    return GameListResponse(
        items=[
            _summary(
                g,
                name=names.get(g.id, g.name),
                slug=slug_map.get(g.id, g.id),
                favs=favs,
                stats=stats,
            )
            for g in chunk
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.put("/{game_id}/favorite", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def add_favorite(
    game_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    if library.index.get(game_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")
    existing = (
        db.query(Favorite)
        .filter(Favorite.user_id == user.id, Favorite.game_id == game_id)
        .first()
    )
    if existing is None:
        db.add(Favorite(user_id=user.id, game_id=game_id, created_at=datetime.now(tz=UTC)))
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{game_id}/favorite", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def remove_favorite(
    game_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    db.query(Favorite).filter(
        Favorite.user_id == user.id, Favorite.game_id == game_id,
    ).delete()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{game_id}/playtime", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def record_playtime(
    game_id: str,
    payload: PlaytimePingRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Increment the user's playtime for this game and bump last-played.

    The frontend tracker posts deltas of "real seconds the tab was visible
    while the emulator was loaded" — typically 60s, or one final beacon on
    page-hide. Anything outside [1, 600] is rejected at the schema layer.
    """
    if library.index.get(game_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")

    row = (
        db.query(GamePlayStat)
        .filter(GamePlayStat.user_id == user.id, GamePlayStat.game_id == game_id)
        .one_or_none()
    )
    now = datetime.now(tz=UTC)
    if row is None:
        row = GamePlayStat(
            user_id=user.id,
            game_id=game_id,
            playtime_seconds=payload.seconds,
            last_played_at=now,
        )
        db.add(row)
    else:
        row.playtime_seconds = (row.playtime_seconds or 0) + payload.seconds
        row.last_played_at = now
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{game_id}", response_model=GameDetail)
def get_game(
    game_id: str,
    response: Response,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> GameDetail:
    # The response carries per-user, per-slot `generation` and
    # `updated_at` watermarks that the client uses for optimistic
    # concurrency. A stale cached copy here would make the client send
    # an old X-Slot-Generation on its next save and either trigger a
    # false 409 or — worse — silently overwrite a newer generation
    # written by another device. Always revalidate.
    response.headers["Cache-Control"] = "no-cache"

    # Try resolving as slug first, then as canonical ID
    resolved_id = resolve_slug(db, game_id) or game_id
    game = library.index.get(resolved_id)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")

    rows = (
        db.query(SaveSlot)
        .filter(SaveSlot.user_id == user.id, SaveSlot.game_id == resolved_id)
        .all()
    )
    rows_by_slot = {r.slot: r for r in rows}

    slots: list[SlotSummary] = []
    for n in range(1, MAX_SLOT + 1):
        row = rows_by_slot.get(n)
        if row is None:
            continue
        slots.append(
            SlotSummary(
                slot=n,
                name=row.name,
                updated_at=row.updated_at,
                has_save=slot_save_path(user.username, resolved_id, n).exists(),
                has_state=slot_state_path(user.username, resolved_id, n).exists(),
                generation=row.generation,
            )
        )

    meta = db.query(GameMeta).filter(GameMeta.game_id == resolved_id).first()
    display_name = (meta.display_name if meta and meta.display_name else game.name)
    slug = meta.slug if meta and meta.slug else resolved_id
    is_fav = (
        db.query(Favorite)
        .filter(Favorite.user_id == user.id, Favorite.game_id == resolved_id)
        .first()
        is not None
    )
    stat = (
        db.query(GamePlayStat)
        .filter(GamePlayStat.user_id == user.id, GamePlayStat.game_id == resolved_id)
        .first()
    )

    return GameDetail(
        id=game.id, slug=slug, name=display_name, system=game.system,
        disks=len(game.disks), has_cover=game.cover_path is not None,
        core=game.core,
        fast_forward_enabled=game.fast_forward_enabled,
        rewind_enabled=game.rewind_enabled,
        disk_names=game.disk_names, slots=slots,
        is_favorite=is_fav,
        description=meta.description if meta else None,
        release_date=meta.release_date if meta else None,
        playtime_seconds=stat.playtime_seconds if stat else 0,
        last_played_at=stat.last_played_at if stat else None,
    )


@router.get("/{game_id}/cover")
def get_cover(game_id: str, _: User = Depends(current_user)) -> FileResponse:
    game = library.index.get(game_id)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")
    cover = game.cover_path
    if cover is None or not cover.is_file():
        default = _default_cover()
        if not default.is_file():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No cover available.")
        return FileResponse(default, media_type="image/svg+xml",
                             headers={"Cache-Control": "public, max-age=86400"})
    media_type = mimetypes.guess_type(cover.name)[0] or "application/octet-stream"
    return FileResponse(cover, media_type=media_type,
                         headers={"Cache-Control": "public, max-age=3600"})


def _get_rom_handler(
    game_id: str,
    request: Request,
    disk: int = Query(default=1, ge=1),
    _: User = Depends(current_user),
) -> Response:
    game = library.index.get(game_id)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Game not found.")
    if disk > len(game.disks):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Disk {disk} not found.")
    return _ranged_file_response(request, game.disks[disk - 1])


# Two routes: with and without filename suffix (EmulatorJS needs the extension in the URL)
router.add_api_route(
    "/{game_id}/rom/{filename:path}",
    _get_rom_handler,
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
router.add_api_route("/{game_id}/rom", _get_rom_handler, methods=["GET", "HEAD"])


def _ranged_file_response(request: Request, path: Path) -> Response:
    """Stream a file with HTTP Range support and ETag for browser caching."""
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ROM file not found.")

    # Decompress .gz on the fly so EmulatorJS receives raw ROM data
    if path.suffix.lower() == ".gz":
        import gzip

        stat = path.stat()
        etag = f'"{stat.st_size:x}-{int(stat.st_mtime):x}-gz"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
        data = gzip.decompress(path.read_bytes())
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"ETag": etag, "Content-Length": str(len(data))},
        )

    stat = path.stat()
    etag = f'"{stat.st_size:x}-{int(stat.st_mtime):x}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "ETag": etag,
            "Accept-Ranges": "bytes",
            "Last-Modified": datetime.fromtimestamp(stat.st_mtime, tz=UTC)
                .strftime("%a, %d %b %Y %H:%M:%S GMT"),
        },
    )
