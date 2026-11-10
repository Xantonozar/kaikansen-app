/**
 * Jest stub for bundled binary assets (see jest.config.js's
 * moduleNameMapper). Metro resolves require('../assets/*.webp')
 * to a numeric asset id at runtime; tests only need the same
 * shape, so every asset require lands here as the number 1.
 */
module.exports = 1;
