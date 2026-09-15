"use strict";

class QuoteExpiredError extends Error {
  constructor(updatedAt) {
    super("quote expired");
    this.name = "QuoteExpiredError";
    this.code = "QUOTE_EXPIRED";
    this.updatedAt = updatedAt;
  }
}

module.exports = { QuoteExpiredError };
