/**
 * Storage reserved for multi-user / leaderboard persistence later.
 * v1 keeps earn state in the in-memory EarnEngine.
 */
export const storage = {
  async ping() {
    return true;
  },
};
