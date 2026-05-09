from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class UserPreference(Base):
    """Free-form per-user JSON-ish preferences (theme, layout flags, etc).

    Storing as a single JSON string column keeps the schema flexible without
    requiring a migration for every new client setting. The frontend treats
    the contents as opaque JSON.
    """

    __tablename__ = "user_preferences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
        index=True,
    )
    data: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
