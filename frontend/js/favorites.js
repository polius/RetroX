/* Favorite toggle helper. */

import { api } from "./api.js";

export async function toggleFavorite(gameId, currentlyFavorite) {
  if (currentlyFavorite) {
    await api.del(`/games/${encodeURIComponent(gameId)}/favorite`);
    return false;
  }
  await api.put(`/games/${encodeURIComponent(gameId)}/favorite`);
  return true;
}
