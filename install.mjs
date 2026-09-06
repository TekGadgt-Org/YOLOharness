#!/usr/bin/env node
import { installPackage } from './src/installer.mjs';
await installPackage(new URL('.', import.meta.url).pathname);
