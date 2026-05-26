import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'

const processes = [
  spawn('python', ['-m', 'uvicorn', 'server.app:app', '--reload', '--host', '127.0.0.1', '--port', '8000'], {
    stdio: 'inherit',
    shell: isWindows,
  }),
  spawn(isWindows ? 'npm.cmd' : 'npm', ['run', 'dev', '--', '--port', '5173'], {
    stdio: 'inherit',
    shell: isWindows,
  }),
]

let shuttingDown = false

function stopAll(code = 0) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const child of processes) {
    if (!child.killed) {
      child.kill(isWindows ? undefined : 'SIGTERM')
    }
  }
  setTimeout(() => process.exit(code), 250)
}

processes.forEach((child) => {
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      stopAll(code ?? 1)
    }
  })
})

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
