import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })
cpSync('src/index.js', 'lib/index.js')
console.log('Built lib/index.js from src/index.js')
