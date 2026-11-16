/**
 * Vitest configuration: one Node project. The host half is pure Node (no DOM,
 * no React), and every suite uses fakes or a temp directory rather than a live
 * harness, so the same run works on a cold checkout.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
    // Temp directories and atomic renames are real filesystem work; the default
    // 5s is enough, but a slow CI disk should not turn a real pass into a flake.
    testTimeout: 15_000,
  },
})
