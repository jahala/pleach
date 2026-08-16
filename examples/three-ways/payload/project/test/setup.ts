// Test preload: register happy-dom so `document`, `HTMLElement`, click events, etc.
// are available in `bun test`. Lets the web UI (src/app.ts) be played in a DOM test.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
