#!/usr/bin/env node
// A source file over 1200 lines has more than one job (designs/2026-10-24-server-split.md). The number is a
// tripwire, not a target. Part of `npm run gates`.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 1200
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const files = execFileSync('git', ['ls-files', '--', '*.ts', '*.tsx', '*.mjs', '*.js', '*.py', '*.sh'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(f => f && !f.startsWith('library/src/'))
const over = files
  .map(f => ({ f, lines: readFileSync(path.join(root, f), 'utf8').split('\n').length }))
  .filter(x => x.lines > LIMIT)
for (const { f, lines } of over) console.error(`${f}: ${lines} lines (limit ${LIMIT}); split it by job`)
process.exit(over.length ? 1 : 0)
