#!/usr/bin/env node
import { buildCli } from './cli.js';

const program = buildCli();
await program.parseAsync(process.argv);
