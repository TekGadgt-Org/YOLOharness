import { runOnce, FixtureProvider } from './runtime.mjs';

export function runFixture({ prompt, minutes, workspace, signal }) {
  return runOnce({ prompt, minutes, workspace, provider: new FixtureProvider(), signal });
}
