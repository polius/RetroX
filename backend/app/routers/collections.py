from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..deps import current_user, get_db, require_admin
from ..models import Collection, CollectionGame, User
from ..services.library import library

router = APIRouter(prefix="/api/collections", tags=["collections"])


class CollectionOut(BaseModel):
    id: int
    name: str
    game_count: int
    created_at: str | None = None


class CollectionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)


class CollectionUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)


class CollectionGamesUpdate(BaseModel):
    game_ids: list[str]


@router.get("", response_model=list[CollectionOut])
def list_collections(user: User = Depends(current_user), db: Session = Depends(get_db)):
    # Count only games currently in the library. Rows for games missing
    # from the last scan are kept (a ROM share can be offline for a scan)
    # but must not inflate the count.
    counts: dict[int, int] = {}
    for cid, gid in db.query(CollectionGame.collection_id, CollectionGame.game_id).all():
        if library.index.get(gid) is not None:
            counts[cid] = counts.get(cid, 0) + 1
    rows = db.query(Collection).order_by(Collection.name).all()
    return [
        CollectionOut(
            id=c.id,
            name=c.name,
            game_count=counts.get(c.id, 0),
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c in rows
    ]


@router.post("", response_model=CollectionOut, status_code=201)
def create_collection(
    body: CollectionCreate,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Collection name cannot be empty.")
    existing = db.query(Collection).filter(Collection.name == name).first()
    if existing:
        raise HTTPException(409, "A collection with that name already exists.")
    c = Collection(name=name)
    db.add(c)
    db.commit()
    db.refresh(c)
    return CollectionOut(
        id=c.id,
        name=c.name,
        game_count=0,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.patch("/{collection_id}", response_model=CollectionOut)
def update_collection(
    collection_id: int,
    body: CollectionUpdate,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    c = db.get(Collection, collection_id)
    if not c:
        raise HTTPException(404, "Collection not found.")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Collection name cannot be empty.")
    duplicate = (
        db.query(Collection)
        .filter(Collection.name == name, Collection.id != collection_id)
        .first()
    )
    if duplicate:
        raise HTTPException(409, "A collection with that name already exists.")
    c.name = name
    db.commit()
    # Same rule as list_collections: only games currently in the library.
    count = sum(
        1 for (gid,) in db.query(CollectionGame.game_id).filter(CollectionGame.collection_id == c.id)
        if library.index.get(gid) is not None
    )
    return CollectionOut(
        id=c.id,
        name=c.name,
        game_count=count,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.delete("/{collection_id}", status_code=204)
def delete_collection(collection_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    c = db.get(Collection, collection_id)
    if not c:
        raise HTTPException(404, "Collection not found.")
    db.delete(c)
    db.commit()


@router.get("/{collection_id}/games")
def get_collection_games(collection_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = db.get(Collection, collection_id)
    if not c:
        raise HTTPException(404, "Collection not found.")
    rows = db.query(CollectionGame).filter(CollectionGame.collection_id == collection_id).all()
    # Skip ids missing from the live index so the manage-games modal can't
    # round-trip stale ids back to the PUT endpoint, which rejects them.
    return [{"id": r.game_id} for r in rows if library.index.get(r.game_id) is not None]


@router.put("/{collection_id}/games", status_code=204)
def set_collection_games(
    collection_id: int,
    body: CollectionGamesUpdate,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    c = db.get(Collection, collection_id)
    if not c:
        raise HTTPException(404, "Collection not found.")
    # Reject any game_id that isn't in the live library. Without this
    # the table happily accumulates rows pointing at deleted/typo'd
    # ROMs, which then surface as broken cards in the UI.
    unknown = [gid for gid in body.game_ids if library.index.get(gid) is None]
    if unknown:
        raise HTTPException(
            400,
            f"Unknown game id(s): {', '.join(unknown[:5])}"
            + ("..." if len(unknown) > 5 else ""),
        )
    # Replace only the memberships the editor could see. Rows for games
    # missing from the current scan stay, so they reappear with the ROM.
    existing = db.query(CollectionGame).filter(CollectionGame.collection_id == collection_id).all()
    for row in existing:
        if library.index.get(row.game_id) is not None:
            db.delete(row)
    kept = {row.game_id for row in existing if library.index.get(row.game_id) is None}
    db.flush()
    for gid in dict.fromkeys(body.game_ids):
        if gid not in kept:
            db.add(CollectionGame(collection_id=collection_id, game_id=gid))
    db.commit()
