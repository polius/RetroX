"""URL slug generation and persistence for games."""
from __future__ import annotations

import re
import unicodedata
from datetime import UTC, datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models.game_meta import GameMeta

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def make_slug(name: str, system: str) -> str:
    """Normalize a display name into a URL-safe slug with system suffix."""
    # Strip accents
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_str = nfkd.encode("ascii", "ignore").decode("ascii")
    slug = _SLUG_RE.sub("-", ascii_str.lower()).strip("-")
    return f"{slug}-{system}" if slug else system


def ensure_meta_for_index(games: dict) -> dict[str, datetime]:
    """Ensure every indexed game has a GameMeta row with a slug and a
    persisted created_at, returning {game_id: created_at}.

    Slug is recomputed every scan so renames flow through. created_at
    is set exactly once — the first time the scanner sees a given
    game_id — and never modified after that, so "Recently Added" is
    immune to file mtime changes (cp without -p, restore-from-backup,
    docker volume migrations).
    """
    now = datetime.now(tz=UTC)
    out: dict[str, datetime] = {}
    with SessionLocal() as db:
        metas = {m.game_id: m for m in db.query(GameMeta).all()}
        used_slugs: dict[str, str] = {}

        for game_id, game in games.items():
            meta = metas.get(game_id)
            display_name = (meta.display_name if meta and meta.display_name else game.name)
            base = make_slug(display_name, game.system)
            slug = base
            counter = 2
            while slug in used_slugs and used_slugs[slug] != game_id:
                slug = f"{base}-{counter}"
                counter += 1
            used_slugs[slug] = game_id

            if meta is None:
                meta = GameMeta(game_id=game_id, slug=slug, created_at=now)
                db.add(meta)
                out[game_id] = now
            else:
                if meta.slug != slug:
                    meta.slug = slug
                # Backfill rows that pre-date the created_at column.
                if meta.created_at is None:
                    meta.created_at = now
                out[game_id] = meta.created_at

        db.commit()
    return out


def regenerate_slug(db: Session, game_id: str, display_name: str, system: str) -> str:
    """Regenerate slug for a single game after rename. Returns new slug.

    Picks a candidate via query then verifies via flush in a SAVEPOINT
    so a concurrent writer racing on the same base can't both win the
    unique-slug check. On IntegrityError we bump the counter and retry.
    """
    base = make_slug(display_name, system)
    bump = 0
    for _ in range(3):
        slug = base if bump == 0 else f"{base}-{bump + 1}"
        existing = db.query(GameMeta).filter(
            GameMeta.slug == slug, GameMeta.game_id != game_id
        ).first()
        if existing is not None:
            bump += 1
            continue
        meta = db.query(GameMeta).filter(GameMeta.game_id == game_id).first()
        if meta is None:
            # Caller is mid-creation; trust the query and let caller commit
            # raise IntegrityError on the rare race. (Pre-existing behavior.)
            return slug
        nested = db.begin_nested()
        try:
            meta.slug = slug
            db.flush()
            nested.commit()
            return slug
        except IntegrityError:
            nested.rollback()
            bump += 1
            continue
    raise RuntimeError("could not allocate unique slug after retries")


def resolve_slug(db: Session, slug: str) -> str | None:
    """Return game_id for a given slug, or None."""
    meta = db.query(GameMeta).filter(GameMeta.slug == slug).first()
    return meta.game_id if meta else None
