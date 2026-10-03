/** An error whose message is safe to show to the MCP client. */
export class ToolError extends Error {}

/** A call refused by a security control before reaching the upstream API. */
export class RefusedError extends ToolError {}

export class HttpError extends ToolError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
