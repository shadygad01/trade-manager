/**
 * Extends Vitest's `expect` with jest-dom's DOM matchers (toBeInTheDocument,
 * toHaveTextContent, etc.) for component tests. Safe to load globally even
 * for non-component tests — it only adds matchers, it doesn't require a DOM
 * to be present at import time.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * This codebase never enables Vitest's `globals` option (every test file
 * explicitly imports describe/it/expect), so React Testing Library's
 * automatic afterEach-cleanup detection — which relies on globals — never
 * fires. Without it, every render() in a component test file leaves its DOM
 * behind for the next test, so unrelated tests can see each other's
 * elements. Registering it once here keeps every component test isolated.
 */
afterEach(cleanup);
