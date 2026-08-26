class GovernanceHistoryAdapter {
  async fetchHistory(_voter, _options = {}) {
    throw new Error("GovernanceHistoryAdapter.fetchHistory must be implemented");
  }
}

module.exports = { GovernanceHistoryAdapter };
