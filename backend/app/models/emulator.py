from __future__ import annotations

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class Emulator(Base):
    __tablename__ = "emulators"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    system: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    extensions: Mapped[str] = mapped_column(String(255), nullable=False)  # comma-separated
    core: Mapped[str] = mapped_column(String(64), nullable=False)
    # When true, RetroX claims L2/R2 for fast forward (R2) and rewind
    # (L2 if rewind_enabled). Disable for systems whose games use those
    # buttons natively (PSX, PS2, N64).
    fast_forward_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    # Requires fast_forward_enabled. Memory-hungry (libretro keeps a
    # rolling frame buffer ~20 MB), and only some cores support it well
    # (gambatte, mgba, snes9x, fceumm, genesis_plus_gx).
    rewind_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
