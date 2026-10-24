// Errors the CLI turns into exit codes (cli/run.ts). `quiet`: the command already printed the story.
export type ErrorCode = 'CANVAS_UNREACHABLE' | 'BROWSER_REQUIRED'

export class CodedError extends Error {
  readonly code: ErrorCode
  quiet: boolean
  constructor(message: string, code: ErrorCode, quiet = false) {
    super(message)
    this.code = code
    this.quiet = quiet
  }
}

export const errorCode = (error: unknown): ErrorCode | undefined =>
  error instanceof CodedError ? error.code : undefined
