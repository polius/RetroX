from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
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
    name: str


class CollectionUpdate(BaseModel):
    name: str


class CollectionGamesUpdate(BaseModel):
    game_ids: list[str]


@router.get("", response_model=list[CollectionOut])
def list_collections(user: User = Depends(current_user), db: Session = Depends(get_db)):
    # Single grouped query instead of one COUNT per collection.
    counts = dict(
        db.query(CollectionGame.collection_id, func.count(CollectionGame.id))
        .group_by(CollectionGame.collection_id)
        .all()
    )
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
    existing = db.query(Collection).filter(Collection.name == body.name.strip()).first()
    if existing:
        raise HTTPException(409, "A collection with that name already exists.")
    c = Collection(name=body.name.strip())
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
    c.name = body.name.strip()
    db.commit()
    count = db.query(CollectionGame).filter(CollectionGame.collection_id == c.id).count()
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
    return [{"id": r.game_id} for r in rows]


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
    db.query(CollectionGame).filter(CollectionGame.collection_id == collection_id).delete()
    for gid in body.game_ids:
        db.add(CollectionGame(collection_id=collection_id, game_id=gid))
    db.commit()
