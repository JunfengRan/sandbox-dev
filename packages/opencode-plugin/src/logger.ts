import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

let logFilePath = ''

export function setLogFilePath(path: string): void {
  logFilePath = path
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function write(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line)
    } catch {
      // ignore
    }
  }
}

export const logger = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
}
