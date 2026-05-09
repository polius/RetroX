from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

# Defined in its own module so routers can import it without forcing a
# late `from ..main import limiter`, which would otherwise break import
# ordering (limiter must exist before any router module is loaded).
limiter = Limiter(key_func=get_remote_address)
